/** Live→Work draft pulls (debounced and at tool boundaries), and a thread peer's identity step. */

import {
  type DiscardedWriteReason,
  type DocumentCoordinator,
  DocumentNotFoundError,
} from "@meridian/agent-edit/integration";
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import type { Branches } from "./branches.js";
import type { DraftCoordinator, PullOutcome } from "./draft-coordinator.js";
import { DraftCasConflictError, type DraftSnapshot, DraftStaleUpdateError } from "./draft-store.js";
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

export type DraftPullService = {
  scheduleLivePull(documentId: DocumentId): void;
  /** Drops debounced pulls that haven't started; in-flight pulls finish. */
  cancelScheduledPulls(): void;
  flushLivePull(documentId: DocumentId): Promise<void>;
  /**
   * Live merged into one work draft, answered for that draft: the projection job's way to
   * establish a legacy draft's baseline (design §3.3). Deleted with the null-baseline arm.
   */
  pullWorkDraft(input: { documentId: DocumentId; draftId: string }): Promise<PullOutcome>;
  /**
   * A draft-mode write's thread peer (identity only, until M4): an existing active peer on
   * the branch, or a new one forked from the Work draft. Never reads or merges content.
   */
  ensureThreadPeer(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    branchId?: BranchId;
  }): Promise<EnsuredThreadPeer>;
};

export type EnsuredThreadPeer = {
  peerDraftId: string;
  upstreamDraftId: string;
};

/**
 * A draft-mode call whose bound peer lost to a Discard after its ensure (a stale, CAS-lost,
 * closed or missing peer, Work draft or branch), carrying the peer and upstream it had bound so
 * a caller can say which one went. Any other failure is not wrapped.
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
    drafts: { getDraft(draftId: string): Promise<Pick<DraftSnapshot, "status"> | null> };
  },
  cause: unknown,
  branchId: BranchId | undefined,
): Promise<DiscardedWriteReason | undefined> {
  const lost = cause instanceof ThreadPeerPullLost;
  if (!lost && !(cause instanceof DraftStaleUpdateError || cause instanceof DraftCasConflictError))
    return undefined;
  if (branchId && !(await deps.branches.shareActive(branchId))) return "discarded_draft";
  if (!lost) return undefined;
  const gone = async (draftId: string) => {
    const documentDraft = await deps.drafts.getDraft(draftId);
    return !documentDraft || documentDraft.status === "closed";
  };
  if (await gone(cause.upstreamDraftId)) return "discarded_document";
  return (await gone(cause.peerDraftId)) ? "discarded_edit" : undefined;
}

export type DraftPullDiagnostics = {
  backgroundFailed(input: { documentId: DocumentId; cause: unknown }): void;
};

export function createDraftPullService(input: {
  outsideTransaction<T>(operation: () => T): T;
  liveCoordinator: Pick<DocumentCoordinator, "withDocument" | "recover">;
  draftCoordinator: DraftCoordinator;
  drafts: WorkDraftLookup;
  debounceMs?: number;
  maxDebounceMs?: number;
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
        if (cause instanceof DocumentNotFoundError)
          return Y.encodeStateAsUpdate(new Y.Doc({ gc: false }));
        throw cause;
      });
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, state);
    return doc;
  }

  /**
   * Whether a pending settlement on the document fenced any draft's pull (the one outcome
   * that re-arms, D20); `blocked` and `closed` drafts are done until something
   * new arrives.
   */
  async function pullLive(documentId: DocumentId): Promise<{ fenced: boolean }> {
    // Most documents have no Work draft; skip the snapshot (a room open and
    // release) for them. Re-list before pulling: a draft can close in
    // between, and one opened since waits for the next pull.
    if ((await input.drafts.listActiveWorkDraftIds(documentId)).length === 0)
      return { fenced: false };
    // Snapshot before any transaction opens: the snapshot takes its own connection,
    // and taking it while holding another lets concurrent pulls hold every pooled
    // connection and wait on each other forever.
    const liveDoc = await liveSnapshot(documentId);
    let fenced = false;
    try {
      // One draft at a time, each attempt its own root transaction (decision D13). A pull
      // folds the frames that commit meanwhile; nothing waits on it.
      for (const draftId of await input.drafts.listActiveWorkDraftIds(documentId)) {
        const outcome = await input.draftCoordinator.pullFromDoc({ draftId, upstream: liveDoc });
        if (outcome === "fenced") fenced = true;
      }
    } finally {
      liveDoc.destroy();
    }
    return { fenced };
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
        .then(({ fenced }) => {
          // A queued snapshot may include newer edits; its retries still need these timers.
          if (entry.queued) return;
          if (entry.debounce) clearTimeout(entry.debounce);
          if (entry.max) clearTimeout(entry.max);
          entry.debounce = undefined;
          entry.max = undefined;
          // Decision D20: a settlement's completion schedules no pull, so a fenced pull re-arms
          // its debounce, one capture and merge per period, until the settlement completes or
          // is withdrawn and the next run commits. Only `fenced` (a pending settlement)
          // re-arms: a terminally `blocked` one never lifts by itself (D22), and a closed
          // draft leaves the active list, so neither keeps the timer alive.
          if (fenced) armDebounce(documentId, entry);
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

    pullWorkDraft({ documentId, draftId }) {
      return outsideCallerTransactions(async () => {
        const liveDoc = await liveSnapshot(documentId);
        try {
          return await input.draftCoordinator.pullFromDoc({ draftId, upstream: liveDoc });
        } finally {
          liveDoc.destroy();
        }
      });
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
