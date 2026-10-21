/** Live→Work draft pulls (debounced and at tool boundaries), and a thread peer's identity step. */

import {
  blocksEqual,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  rebase,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import {
  type DocumentCoordinator,
  isDocumentNotFoundError,
  type RetiredWriteReason,
  type UpdateJournal,
} from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { DocumentRemovals } from "../../context/ports/document-removal.js";
import type { Branches } from "./branches.js";
import { closedPinReason } from "./closed-pin-reason.js";
import type { DraftCoordinator } from "./draft-coordinator.js";
import { DraftCasConflictError, type DraftSnapshot, DraftStaleUpdateError } from "./draft-store.js";
import type { LiveDocumentCoordinator } from "./ports/live-document-coordinator.js";
import { runOutsideResponseTransaction } from "./response-transaction.js";

export type WorkDraftLookup = {
  listActiveWorkDraftIds(documentId: DocumentId): Promise<string[]>;
  ensureThreadPeerDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    branchId?: BranchId;
    /** Live as it stands, asked for only when the ensure makes a Work draft to seed. */
    liveDoc: () => Promise<Y.Doc>;
  }): Promise<{ documentDraft: Pick<DraftSnapshot, "draftId" | "upstreamDraftId"> }>;
};

export type EnsuredThreadPeer = { peerDraftId: string; upstreamDraftId: string };

export type DraftPullService = {
  scheduleLivePull(documentId: DocumentId): void;
  /** Drops debounced pulls that haven't started; in-flight pulls finish. */
  cancelScheduledPulls(): void;
  flushLivePull(documentId: DocumentId): Promise<void>;
  ensureThreadPeer(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    branchId?: BranchId;
  }): Promise<EnsuredThreadPeer>;
};

/**
 * A thread-peer pull whose draft operations lost to a Discard (stale, CAS-lost, closed or missing
 * draft, or an upstream closed after its read), carrying the peer and upstream it had
 * captured so a caller can say which one went. Any other failure of the pull is not wrapped.
 */
export class ThreadPeerPullLost extends Error {
  constructor(
    readonly peerDraftId: string,
    readonly upstreamDraftId: string,
    cause: unknown,
  ) {
    super(`Thread peer ${peerDraftId} pull lost its drafts`, { cause });
    this.name = "ThreadPeerPullLost";
  }
}

/**
 * Why a draft access failure is a writer's Discard, in the save fence's precedence: the branch
 * it wrote for is closed (Discard all), else the peer's Work draft is closed or gone (the
 * document's Discard), else the peer is (an item Discard re-forked it). `undefined` when no
 * Discard explains it.
 */
export async function peerLossReason(
  deps: {
    branches: Pick<Branches, "shareActive">;
    drafts: {
      getDraft(
        draftId: string,
      ): Promise<Pick<DraftSnapshot, "status" | "closedCause" | "documentId"> | null>;
    };
    removals: DocumentRemovals;
  },
  cause: unknown,
  branchId: BranchId | undefined,
  documentId?: string | null,
): Promise<RetiredWriteReason | undefined> {
  if (isDocumentNotFoundError(cause) && cause.removal) return { removed: cause.removal };
  const lost = cause instanceof ThreadPeerPullLost;
  if (!lost && !(cause instanceof DraftStaleUpdateError || cause instanceof DraftCasConflictError))
    return undefined;
  const branchActive = !branchId || Boolean(await deps.branches.shareActive(branchId));
  if (!lost) return branchActive ? undefined : "discarded_draft";
  const [upstream, peer] = await Promise.all([
    deps.drafts.getDraft(cause.upstreamDraftId),
    deps.drafts.getDraft(cause.peerDraftId),
  ]);
  const id = documentId ?? upstream?.documentId ?? peer?.documentId;
  const removals = id ? await deps.removals.lookup([id as DocumentId]) : undefined;
  return closedPinReason({
    branchActive,
    upstream,
    peer,
    removal: removals?.get(id as DocumentId),
  });
}

export type DraftPullDiagnostics = {
  backgroundFailed(input: { documentId: DocumentId; cause: unknown }): void;
};

export function createDraftPullService(input: {
  outsideTransaction<T>(operation: () => T): T;
  liveCoordinator: Pick<LiveDocumentCoordinator, "withDocument">;
  draftCoordinator: DraftCoordinator;
  drafts: WorkDraftLookup;
  debounceMs?: number;
  maxDebounceMs?: number;
  liveJournal: Pick<UpdateJournal, "read">;
  diagnostics?: DraftPullDiagnostics;
}): DraftPullService {
  const debounceMs = input.debounceMs ?? 2000;
  const maxDebounceMs = input.maxDebounceMs ?? 10000;
  const timers = new Map<
    string,
    {
      debounce?: NodeJS.Timeout;
      max?: NodeJS.Timeout;
      running?: Promise<void>;
      queued?: Promise<void>;
    }
  >();

  function outsideCallerTransactions<T>(operation: () => T): T {
    return input.outsideTransaction(() => runOutsideResponseTransaction(operation));
  }

  async function liveSnapshot(documentId: DocumentId): Promise<Y.Doc> {
    // Releasing the room checkpoints it under the document's mutation lock. In
    // a caller's transaction that lock would outlive the snapshot and block the
    // root pull in `run` that the caller then waits on.
    const state = await input
      .outsideTransaction(() =>
        input.liveCoordinator.withDocument(documentId, async (liveDoc) =>
          Y.encodeStateAsUpdate(liveDoc),
        ),
      )
      .catch((cause: unknown) => {
        // A live side with no state yet (a hidden creation) is an empty upstream; a removed
        // document is not, and its pull fails by name.
        if (isDocumentNotFoundError(cause) && !cause.removal)
          return Y.encodeStateAsUpdate(new Y.Doc({ gc: false }));
        throw cause;
      });
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, state);
    return doc;
  }

  const schema = buildDocumentSchema();

  async function committedLive(documentId: DocumentId): Promise<Y.Doc> {
    const cut = await input.liveJournal.read(documentId);
    const doc = new Y.Doc({ gc: false });
    try {
      if (cut.checkpoint) Y.applyUpdate(doc, cut.checkpoint);
      for (const row of cut.updates) Y.applyUpdate(doc, row.update);
      return doc;
    } catch (cause) {
      doc.destroy();
      throw cause;
    }
  }

  async function pullLive(documentId: DocumentId): Promise<void> {
    const drafts = await input.drafts.listActiveWorkDraftIds(documentId);
    if (!drafts.length) return;
    const live = await committedLive(documentId);
    try {
      const blocks = readBlocks(live.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME), schema);
      for (const draftId of drafts) {
        const base = await input.draftCoordinator.loadBase(draftId);
        if (base.snapshot.status !== "active") continue;
        if (
          blocksEqual(
            readBlocks(base.replica.doc.getXmlFragment(REVIEW_BASE_FRAGMENT), schema),
            blocks,
          )
        )
          continue;
        const write = input.draftCoordinator.prepareAppend(base, [], {
          work: "any",
          async authorServerRows(prefix) {
            // A committed Apply in this prefix also committed its live row. Read live after
            // the draft lock, without taking live's lock or importing any of its Yjs identity.
            const current = await committedLive(documentId);
            try {
              const nextBase = readBlocks(
                current.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME),
                schema,
              );
              const reviewBase = prefix.getXmlFragment(REVIEW_BASE_FRAGMENT);
              const oldBase = readBlocks(reviewBase, schema);
              if (blocksEqual(oldBase, nextBase)) return [];
              const fragment = prefix.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
              const merged = rebase(schema, oldBase, nextBase, readBlocks(fragment, schema));
              return captureMutationUpdates(prefix, () =>
                prefix.transact(() => {
                  writeBlocks(fragment, schema, merged.blocks);
                  writeBlocks(reviewBase, schema, nextBase);
                }),
              );
            } finally {
              current.destroy();
            }
          },
        });
        try {
          await write.persist();
          await write.transfer();
        } finally {
          write.dispose();
        }
      }
    } finally {
      live.destroy();
    }
  }

  async function run(documentId: DocumentId): Promise<void> {
    const current = timers.get(documentId);
    if (current?.running) {
      // A joiner needs a snapshot captured after its call, not the in-flight
      // snapshot that may predate a writer edit. Coalesce joins into one rerun.
      const running = current.running;
      current.queued ??= outsideCallerTransactions(() => {
        const rerun = () => {
          current.queued = undefined;
          return run(documentId);
        };
        return running.then(rerun, rerun);
      });
      return current.queued;
    }
    const entry = current ?? {};
    const running = outsideCallerTransactions(() =>
      pullLive(documentId)
        .then(() => {
          // A queued snapshot may include newer edits; its retries still need these timers.
          if (entry.queued) return;
          if (entry.debounce) clearTimeout(entry.debounce);
          if (entry.max) clearTimeout(entry.max);
          entry.debounce = undefined;
          entry.max = undefined;
        })
        .finally(() =>
          outsideCallerTransactions(() => {
            entry.running = undefined;
            if (!entry.queued && !entry.debounce && !entry.max) timers.delete(documentId);
          }),
        ),
    );
    entry.running = running;
    timers.set(documentId, entry);
    return running;
  }

  function backgroundPull(documentId: DocumentId): void {
    void run(documentId).catch((cause: unknown) => {
      input.diagnostics?.backgroundFailed({ documentId, cause });
    });
  }

  function armDebounce(documentId: DocumentId, entry: NonNullable<ReturnType<typeof timers.get>>) {
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = undefined;
      backgroundPull(documentId);
    }, debounceMs);
  }

  return {
    scheduleLivePull(documentId) {
      const entry = timers.get(documentId) ?? {};
      if (entry.running) backgroundPull(documentId);
      armDebounce(documentId, entry);
      entry.max ??= setTimeout(() => {
        entry.max = undefined;
        backgroundPull(documentId);
      }, maxDebounceMs);
      timers.set(documentId, entry);
    },

    cancelScheduledPulls() {
      for (const [documentId, entry] of timers) {
        if (entry.debounce) clearTimeout(entry.debounce);
        if (entry.max) clearTimeout(entry.max);
        entry.debounce = undefined;
        entry.max = undefined;
        if (!entry.running && !entry.queued) timers.delete(documentId);
      }
    },

    flushLivePull(documentId) {
      return run(documentId);
    },

    ensureThreadPeer(inputPeer) {
      return runOutsideResponseTransaction(async () => {
        // An existing peer takes no live snapshot: it seeds only a Work draft the ensure makes.
        let seed: Y.Doc | undefined;
        let peer: Awaited<ReturnType<WorkDraftLookup["ensureThreadPeerDraft"]>>["documentDraft"];
        try {
          peer = (
            await input.drafts.ensureThreadPeerDraft({
              ...inputPeer,
              liveDoc: async () => {
                seed ??= await liveSnapshot(inputPeer.documentId);
                return seed;
              },
            })
          ).documentDraft;
        } finally {
          seed?.destroy();
        }
        const upstreamDraftId = peer.upstreamDraftId;
        if (!upstreamDraftId)
          throw new Error(`Thread peer ${peer.draftId} has no upstream Work draft`);
        return { peerDraftId: peer.draftId, upstreamDraftId };
      });
    },
  };
}
