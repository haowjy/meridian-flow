/** Debounced parent-to-child branch pulls for shadow-mode branch peers. */

import {
  type DocumentCoordinator,
  DocumentNotFoundError,
  type UpdateJournal,
  yjsUpdateFromState,
} from "@meridian/agent-edit/integration";
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import type { BranchConcurrentJournalWatermarks } from "./branch-agent-edit.js";
import type { BranchCoordinator, PullOutcome } from "./branch-coordinator.js";
import {
  BranchCasConflictError,
  BranchMissingError,
  type BranchSnapshot,
  BranchStaleUpdateError,
} from "./branch-store.js";
import { collabHook } from "./collab-test-hooks.js";
import { runOutsideResponseTransaction } from "./response-transaction.js";

export type WorkDraftLookup = {
  listActiveWorkDraftBranchIds(documentId: DocumentId): Promise<string[]>;
  ensureThreadPeerBranch(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId?: DraftId;
    liveDoc: Y.Doc;
  }): Promise<{
    branch: Pick<BranchSnapshot, "branchId" | "upstreamBranchId">;
    /** The peer's content as the ensure left it. */
    state: Uint8Array;
  }>;
};

export type BranchPullService = {
  scheduleLivePull(documentId: DocumentId): void;
  /** Drops debounced pulls that haven't started; in-flight pulls finish. */
  cancelScheduledPulls(): void;
  flushLivePull(documentId: DocumentId): Promise<void>;
  pullThreadPeer(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId?: DraftId;
  }): Promise<{
    peerBranchId: string;
    upstreamBranchId: string;
    branchGeneration: number;
    afterJournalId?: number;
    liveJournalSeq?: number;
    attributionBaseline: Uint8Array;
  }>;
};

/**
 * A thread-peer pull whose branch work lost to a Discard (stale, CAS-lost, closed or missing
 * branch, or an upstream re-forked after its read), carrying the peer and upstream it had
 * captured so a caller can say which one went. Any other failure of the pull is not wrapped.
 */
export class ThreadPeerPullLost extends Error {
  constructor(
    readonly peerBranchId: string,
    readonly upstreamBranchId: string,
    cause: unknown,
  ) {
    super(`Thread peer ${peerBranchId} pull lost its branches`, { cause });
    this.name = "ThreadPeerPullLost";
  }
}

export type BranchPullDiagnostics = {
  backgroundFailed(input: { documentId: DocumentId; cause: unknown }): void;
};

export function createBranchPullService(input: {
  outsideTransaction<T>(operation: () => T): T;
  liveCoordinator: DocumentCoordinator;
  branchCoordinator: BranchCoordinator;
  branches: WorkDraftLookup;
  debounceMs?: number;
  maxDebounceMs?: number;
  concurrentJournalWatermarks?: BranchConcurrentJournalWatermarks;
  liveJournal?: Pick<UpdateJournal, "read">;
  diagnostics?: BranchPullDiagnostics;
}): BranchPullService {
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
   * Whether a pending settlement on the document fenced any branch's pull (the one outcome
   * that re-arms, D20); `blocked` and `closed` branches are done until something
   * new arrives.
   */
  async function pullLive(documentId: DocumentId): Promise<{ fenced: boolean }> {
    // Most documents have no Work draft; skip the snapshot (a room open and
    // release) for them. Re-list before pulling: a branch can close in
    // between, and one opened since waits for the next pull.
    if ((await input.branches.listActiveWorkDraftBranchIds(documentId)).length === 0)
      return { fenced: false };
    // Snapshot before any transaction opens: the snapshot takes its own connection,
    // and taking it while holding another lets concurrent pulls hold every pooled
    // connection and wait on each other forever.
    const liveDoc = await liveSnapshot(documentId);
    let fenced = false;
    try {
      // One branch at a time, each attempt its own root transaction (decision D13). A pull
      // folds the frames that commit meanwhile; nothing waits on it.
      for (const branchId of await input.branches.listActiveWorkDraftBranchIds(documentId)) {
        const outcome = await input.branchCoordinator.pullFromDoc({ branchId, upstream: liveDoc });
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
          // branch leaves the active list, so neither keeps the timer alive.
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

    pullThreadPeer(inputPeer) {
      return runOutsideResponseTransaction(async () => {
        const ensurePeer = async () => {
          const liveDoc = await liveSnapshot(inputPeer.documentId);
          try {
            return await input.branches.ensureThreadPeerBranch({ ...inputPeer, liveDoc });
          } finally {
            liveDoc.destroy();
          }
        };
        const ensured = await ensurePeer();
        const first = ensured.branch;
        // From here every phase fails by name: the identities the ensures returned are
        // captured, so a Discard landing in any later phase is `ThreadPeerPullLost`.
        let identity = { peerBranchId: first.branchId, upstreamBranchId: first.upstreamBranchId };
        try {
          const attributionBaseline = ensured.state;
          await run(inputPeer.documentId);
          const liveCut = await input.liveJournal?.read(inputPeer.documentId);
          const liveJournalSeq = liveCut
            ? (liveCut.persistenceWatermark ??
              liveCut.updates.reduce((latest, update) => Math.max(latest, update.seq), 0))
            : undefined;
          const peer = (await ensurePeer()).branch;
          identity = { peerBranchId: peer.branchId, upstreamBranchId: peer.upstreamBranchId };
          const afterJournalId = input.concurrentJournalWatermarks?.current(
            inputPeer.threadId,
            inputPeer.documentId,
          );
          const upstreamBranchId = peer.upstreamBranchId;
          if (!upstreamBranchId)
            throw new Error(`Thread peer ${peer.branchId} has no upstream Work draft branch`);
          // The upstream is read at its epoch, and the peer's commit holds that epoch: a
          // per-change Discard that re-forked the upstream since the read wins, and the stale
          // capture is abandoned, never merged back. The pull's attempts are root
          // transactions of their own: it commits even when the caller's transaction aborts.
          const upstream = await input.outsideTransaction(async () => {
            await collabHook("branch.beforeAccess");
            const read = await input.branchCoordinator.readBranch(
              upstreamBranchId,
              (doc, snapshot) =>
                Promise.resolve({
                  generation: snapshot.generation,
                  state: Y.encodeStateAsUpdate(doc),
                }),
            );
            const outcome = await pullPeerFromCapturedUpstream(peer.branchId, {
              branchId: upstreamBranchId,
              generation: read.generation,
              state: read.state,
            });
            if (outcome !== "pulled") throw new PeerPullRefused(peer.branchId, outcome);
            return read;
          });
          return {
            peerBranchId: peer.branchId,
            upstreamBranchId,
            branchGeneration: upstream.generation,
            afterJournalId,
            liveJournalSeq,
            attributionBaseline,
          };
        } catch (cause) {
          if (
            identity.upstreamBranchId &&
            (cause instanceof BranchStaleUpdateError ||
              cause instanceof BranchCasConflictError ||
              cause instanceof BranchMissingError ||
              cause instanceof PeerPullRefused)
          )
            throw new ThreadPeerPullLost(identity.peerBranchId, identity.upstreamBranchId, cause);
          throw cause;
        }
      });
    },
  };

  async function pullPeerFromCapturedUpstream(
    peerBranchId: string,
    upstream: { branchId: string; generation: number; state: Uint8Array },
  ): Promise<PullOutcome> {
    const upstreamDoc = docFromSnapshot(upstream.state);
    try {
      return await input.branchCoordinator.pullFromDoc({
        branchId: peerBranchId,
        upstream: upstreamDoc,
        upstreamEpoch: { branchId: upstream.branchId, generation: upstream.generation },
      });
    } finally {
      upstreamDoc.destroy();
    }
  }
}

/** A peer pull the store refused: its peer closed, or its upstream re-forked since the read. */
class PeerPullRefused extends Error {
  constructor(
    readonly peerBranchId: string,
    readonly outcome: Exclude<PullOutcome, "pulled">,
  ) {
    super(`Thread peer ${peerBranchId} pull was refused: ${outcome}`);
    this.name = "PeerPullRefused";
  }
}

function docFromSnapshot(snapshot: Uint8Array): Y.Doc {
  return yjsUpdateFromState(snapshot);
}
