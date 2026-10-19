/** Debounced parent-to-child draft pulls for shadow-mode draft peers. */

import {
  blocksEqual,
  REVIEW_BASE_FRAGMENT,
  readBlocks,
  rebase,
  writeBlocks,
} from "@meridian/agent-edit/diff";
import {
  type DocumentCoordinator,
  DocumentNotFoundError,
  type UpdateJournal,
  yjsUpdateFromState,
} from "@meridian/agent-edit/integration";
import { captureMutationUpdates } from "@meridian/agent-edit/yjs-mutation";
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import { buildDocumentSchema, PROSEMIRROR_FRAGMENT_NAME } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import { testHook } from "../../../shared/test-hooks.js";
import type { DraftConcurrentJournalWatermarks } from "./draft-agent-edit.js";
import type { DraftCoordinator, PullOutcome } from "./draft-coordinator.js";
import {
  DraftCasConflictError,
  DraftMissingError,
  type DraftSnapshot,
  DraftStaleUpdateError,
} from "./draft-store.js";
import { runOutsideResponseTransaction } from "./response-transaction.js";

export type WorkDraftLookup = {
  listActiveWorkDraftIds(documentId: DocumentId): Promise<string[]>;
  ensureThreadPeerDraft(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    branchId?: BranchId;
    liveDoc: Y.Doc;
  }): Promise<{
    documentDraft: Pick<DraftSnapshot, "draftId" | "upstreamDraftId">;
    /** The peer's content as the ensure left it. */
    state: Uint8Array;
  }>;
};

export type DraftPullService = {
  scheduleLivePull(documentId: DocumentId): void;
  /** Drops debounced pulls that haven't started; in-flight pulls finish. */
  cancelScheduledPulls(): void;
  flushLivePull(documentId: DocumentId): Promise<void>;
  pullThreadPeer(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    branchId?: BranchId;
  }): Promise<{
    peerDraftId: string;
    upstreamDraftId: string;
    draftGeneration: number;
    afterJournalId?: number;
    liveJournalSeq?: number;
    attributionBaseline: Uint8Array;
  }>;
};

/**
 * A thread-peer pull whose draft operations lost to a Discard (stale, CAS-lost, closed or missing
 * draft, or an upstream re-forked after its read), carrying the peer and upstream it had
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

export type DraftPullDiagnostics = {
  backgroundFailed(input: { documentId: DocumentId; cause: unknown }): void;
};

export function createDraftPullService(input: {
  outsideTransaction<T>(operation: () => T): T;
  liveCoordinator: DocumentCoordinator;
  draftCoordinator: DraftCoordinator;
  drafts: WorkDraftLookup;
  debounceMs?: number;
  maxDebounceMs?: number;
  concurrentJournalWatermarks?: DraftConcurrentJournalWatermarks;
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
        if (cause instanceof DocumentNotFoundError && !cause.removal)
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

    pullThreadPeer(inputPeer) {
      return runOutsideResponseTransaction(async () => {
        const ensurePeer = async () => {
          const liveDoc = await liveSnapshot(inputPeer.documentId);
          try {
            return await input.drafts.ensureThreadPeerDraft({ ...inputPeer, liveDoc });
          } finally {
            liveDoc.destroy();
          }
        };
        const ensured = await ensurePeer();
        const first = ensured.documentDraft;
        // From here every phase fails by name: the identities the ensures returned are
        // captured, so a Discard landing in any later phase is `ThreadPeerPullLost`.
        let identity = { peerDraftId: first.draftId, upstreamDraftId: first.upstreamDraftId };
        try {
          const attributionBaseline = ensured.state;
          await run(inputPeer.documentId);
          const liveCut = await input.liveJournal?.read(inputPeer.documentId);
          const liveJournalSeq = liveCut
            ? (liveCut.persistenceWatermark ??
              liveCut.updates.reduce((latest, update) => Math.max(latest, update.seq), 0))
            : undefined;
          const peer = (await ensurePeer()).documentDraft;
          identity = { peerDraftId: peer.draftId, upstreamDraftId: peer.upstreamDraftId };
          const afterJournalId = input.concurrentJournalWatermarks?.current(
            inputPeer.threadId,
            inputPeer.documentId,
          );
          const upstreamDraftId = peer.upstreamDraftId;
          if (!upstreamDraftId)
            throw new Error(`Thread peer ${peer.draftId} has no upstream Work draft`);
          // The upstream is read at its epoch, and the peer's commit holds that epoch: a
          // per-change Discard that re-forked the upstream since the read wins, and the stale
          // capture is abandoned, never merged back. The pull's attempts are root
          // transactions of their own: it commits even when the caller's transaction aborts.
          const upstream = await input.outsideTransaction(async () => {
            await testHook("draft.beforeAccess");
            const read = await input.draftCoordinator.readDraft(upstreamDraftId, (doc, snapshot) =>
              Promise.resolve({
                generation: snapshot.generation,
                state: Y.encodeStateAsUpdate(doc),
              }),
            );
            const outcome = await pullPeerFromCapturedUpstream(peer.draftId, {
              draftId: upstreamDraftId,
              generation: read.generation,
              state: read.state,
            });
            if (outcome !== "pulled") throw new PeerPullRefused(peer.draftId, outcome);
            return read;
          });
          return {
            peerDraftId: peer.draftId,
            upstreamDraftId,
            draftGeneration: upstream.generation,
            afterJournalId,
            liveJournalSeq,
            attributionBaseline,
          };
        } catch (cause) {
          if (
            identity.upstreamDraftId &&
            (cause instanceof DraftStaleUpdateError ||
              cause instanceof DraftCasConflictError ||
              cause instanceof DraftMissingError ||
              cause instanceof PeerPullRefused)
          )
            throw new ThreadPeerPullLost(identity.peerDraftId, identity.upstreamDraftId, cause);
          throw cause;
        }
      });
    },
  };

  async function pullPeerFromCapturedUpstream(
    peerDraftId: string,
    upstream: { draftId: string; generation: number; state: Uint8Array },
  ): Promise<PullOutcome> {
    const upstreamDoc = yjsUpdateFromState(upstream.state);
    try {
      return await input.draftCoordinator.pullFromDoc({
        draftId: peerDraftId,
        upstream: upstreamDoc,
        upstreamEpoch: { draftId: upstream.draftId, generation: upstream.generation },
      });
    } finally {
      upstreamDoc.destroy();
    }
  }
}

/** A peer pull the store refused: its peer closed, or its upstream re-forked since the read. */
class PeerPullRefused extends Error {
  constructor(
    readonly peerDraftId: string,
    readonly outcome: Exclude<PullOutcome, "pulled">,
  ) {
    super(`Thread peer ${peerDraftId} pull was refused: ${outcome}`);
    this.name = "PeerPullRefused";
  }
}
