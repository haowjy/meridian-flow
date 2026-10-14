/**
 * Debounced live-to-draft catch-up. A Work draft rebases onto live's certified cut (`draft-rebase.ts`);
 * a thread peer pulls its Work draft's Yjs state. Every branch is caught up under its own lease.
 */

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
import {
  BranchCasConflictError,
  type BranchCoordinator,
  BranchMissingError,
  type BranchSnapshot,
  BranchStaleUpdateError,
} from "./branch-coordinator.js";
import type { BranchLockLease } from "./branch-critical-sections.js";
import type { DraftRebase } from "./draft-rebase.js";
import { runOutsideResponseTransaction } from "./response-transaction.js";

export type WorkDraftLookup = {
  listActiveWorkDraftBranchIds(documentId: DocumentId): Promise<string[]>;
  ensureThreadPeerBranch(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    draftId?: DraftId;
    liveDoc: Y.Doc;
  }): Promise<Pick<BranchSnapshot, "branchId" | "upstreamBranchId" | "state">>;
};

export type BranchPullService = {
  scheduleLivePull(documentId: DocumentId): void;
  /** Drops debounced pulls that haven't started; in-flight pulls finish but arm no retry. */
  cancelScheduledPulls(): void;
  /**
   * Shutdown: cancels, refuses every later schedule or flush, and settles once the pulls already
   * running have finished, so nothing starts and nothing is left in flight.
   */
  close(): Promise<void>;
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
 * A thread-peer pull whose branch work lost to a Discard (stale, CAS-lost or missing branch),
 * carrying the peer and upstream it had captured so a caller can say which one went. Any
 * other failure of the pull is not wrapped.
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
  /** `branchId` names the branch whose pull failed, when the failure belongs to one. */
  backgroundFailed(input: { documentId: DocumentId; branchId?: string; cause: unknown }): void;
};

/** A pull failed at one branch. Internal: the public edge rethrows `cause`, which callers match on. */
class BranchPullFailure extends Error {
  constructor(
    readonly branchId: string,
    override readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "BranchPullFailure";
  }
}

/** The merge of a draft onto live failed. It repeats on the same inputs, so the pull fails without a retry. */
export class DraftRebaseFailedError extends Error {
  constructor(readonly reason: "base_uninitialized" | "merge_failed") {
    super(`Draft rebase failed: ${reason}`);
    this.name = "DraftRebaseFailedError";
  }
}

async function atBranch<T>(branchId: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (cause) {
    throw new BranchPullFailure(branchId, cause);
  }
}

/**
 * `fenced`: an unfinished settlement blocked a rebase. The fence lifts on its own, but nothing else
 * would pull again, so the caller keeps a retry armed. `failure`: a rebase failed; it repeats on the
 * same inputs, so it is reported and not retried (the next live write is the new input).
 */
type PullResult = { fenced: boolean; failure?: BranchPullFailure };

export function createBranchPullService(input: {
  outsideTransaction<T>(operation: () => T): T;
  rootTransaction<T>(operation: () => Promise<T>): Promise<T>;
  liveCoordinator: DocumentCoordinator;
  branchCoordinator: BranchCoordinator;
  branches: WorkDraftLookup;
  debounceMs?: number;
  maxDebounceMs?: number;
  concurrentJournalWatermarks?: BranchConcurrentJournalWatermarks;
  liveJournal?: Pick<UpdateJournal, "read">;
  diagnostics?: BranchPullDiagnostics;
  /** The rebase every Work draft takes onto live; thread peers pull Yjs state instead. */
  draftRebase: Pick<DraftRebase, "catchUp">;
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
  let closed = false;
  /** Bumped by cancel: a run that started before it must not arm a retry. */
  let cancelEpoch = 0;

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

  async function pullLive(documentId: DocumentId): Promise<PullResult> {
    // Most documents have no Work draft. Re-list before pulling: a branch can close in between,
    // and one opened since waits for the next pull.
    const branchIds = await input.branches.listActiveWorkDraftBranchIds(documentId);
    let fenced = false;
    let failure: BranchPullFailure | undefined;
    // One branch at a time: its lease, then its transaction (the save's order), and the
    // transaction commits before the next branch's lease is taken. Every draft is attempted;
    // the first failure is returned.
    for (const branchId of branchIds) {
      const outcome = await atBranch(branchId, () =>
        input.branchCoordinator.withLeases([branchId], (lease) =>
          input.rootTransaction(() => input.draftRebase.catchUp(lease, branchId)),
        ),
      );
      switch (outcome.kind) {
        case "fenced":
          fenced = true;
          break;
        case "failed":
          failure ??= new BranchPullFailure(branchId, new DraftRebaseFailedError(outcome.reason));
          break;
        case "rebased":
        case "noop":
          break;
        default:
          assertNever(outcome);
      }
    }
    return { fenced, ...(failure ? { failure } : {}) };
  }

  async function run(documentId: DocumentId, epoch = cancelEpoch): Promise<void> {
    if (closed) return;
    const current = timers.get(documentId);
    if (current?.running) {
      // A joiner needs a snapshot captured after its call, not the in-flight
      // snapshot that may predate a writer edit. Coalesce joins into one rerun.
      const running = current.running;
      current.queued ??= outsideCallerTransactions(() => {
        const rerun = () => {
          current.queued = undefined;
          return run(documentId, epoch);
        };
        return running.then(rerun, rerun);
      });
      return current.queued;
    }
    const entry = current ?? {};
    const running = outsideCallerTransactions(() =>
      pullLive(documentId)
        .then(({ fenced, failure }) => {
          if (fenced && epoch === cancelEpoch && !closed) {
            entry.max ??= setTimeout(() => {
              entry.max = undefined;
              backgroundPull(documentId);
            }, maxDebounceMs);
          } else if (!entry.queued) {
            // A queued snapshot may include newer edits; its retries still need these timers.
            if (entry.debounce) clearTimeout(entry.debounce);
            if (entry.max) clearTimeout(entry.max);
            entry.debounce = undefined;
            entry.max = undefined;
          }
          if (failure) throw failure;
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

  function cancelScheduledPulls(): void {
    cancelEpoch += 1;
    for (const [documentId, entry] of timers) {
      if (entry.debounce) clearTimeout(entry.debounce);
      if (entry.max) clearTimeout(entry.max);
      entry.debounce = undefined;
      entry.max = undefined;
      if (!entry.running && !entry.queued) timers.delete(documentId);
    }
  }

  function backgroundPull(documentId: DocumentId): void {
    void run(documentId).catch((cause: unknown) => {
      input.diagnostics?.backgroundFailed(
        cause instanceof BranchPullFailure
          ? { documentId, branchId: cause.branchId, cause: cause.cause }
          : { documentId, cause },
      );
    });
  }

  /** `run` for callers: they match on the underlying failure, not on which branch it came from. */
  async function runForCaller(documentId: DocumentId): Promise<void> {
    try {
      await run(documentId);
    } catch (cause) {
      throw cause instanceof BranchPullFailure ? cause.cause : cause;
    }
  }

  return {
    scheduleLivePull(documentId) {
      if (closed) return;
      const entry = timers.get(documentId) ?? {};
      if (entry.running) backgroundPull(documentId);
      if (entry.debounce) clearTimeout(entry.debounce);
      entry.debounce = setTimeout(() => {
        entry.debounce = undefined;
        backgroundPull(documentId);
      }, debounceMs);
      entry.max ??= setTimeout(() => {
        entry.max = undefined;
        backgroundPull(documentId);
      }, maxDebounceMs);
      timers.set(documentId, entry);
    },

    cancelScheduledPulls,

    async close() {
      closed = true;
      cancelScheduledPulls();
      // Pulls already running (and the rerun queued behind one) finish; none starts after this.
      while (true) {
        const inFlight = [...timers.values()].flatMap((entry) =>
          [entry.running, entry.queued].filter((pull): pull is Promise<void> => Boolean(pull)),
        );
        if (inFlight.length === 0) return;
        await Promise.allSettled(inFlight);
      }
    },

    flushLivePull(documentId) {
      return runForCaller(documentId);
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
        const first = await ensurePeer();
        // From here every phase fails by name: the identities the ensures returned are
        // captured, so a Discard landing in any later phase is `ThreadPeerPullLost`.
        let identity = { peerBranchId: first.branchId, upstreamBranchId: first.upstreamBranchId };
        try {
          const attributionBaseline = first.state;
          await runForCaller(inputPeer.documentId);
          const liveCut = await input.liveJournal?.read(inputPeer.documentId);
          const liveJournalSeq = liveCut
            ? (liveCut.persistenceWatermark ??
              liveCut.updates.reduce((latest, update) => Math.max(latest, update.seq), 0))
            : undefined;
          const peer = await ensurePeer();
          identity = { peerBranchId: peer.branchId, upstreamBranchId: peer.upstreamBranchId };
          const afterJournalId = input.concurrentJournalWatermarks?.current(
            inputPeer.threadId,
            inputPeer.documentId,
          );
          const upstreamBranchId = peer.upstreamBranchId;
          if (!upstreamBranchId)
            throw new Error(`Thread peer ${peer.branchId} has no upstream Work draft branch`);
          // The peer's and its upstream's leases are held from capture through persisting
          // the peer, so a per-change Discard cannot refork the upstream in between and a
          // stale capture is never merged back. Leases come before the transaction.
          const upstream = await input.branchCoordinator.withLeases(
            [peer.branchId, upstreamBranchId],
            (lease) =>
              input.rootTransaction(async () => {
                const read = await input.branchCoordinator
                  .ownedSession(lease)
                  .read(upstreamBranchId, (doc, snapshot) =>
                    Promise.resolve({
                      generation: snapshot.generation,
                      state: Y.encodeStateAsUpdate(doc),
                    }),
                  );
                await pullPeerFromCapturedUpstream(lease, peer.branchId, read.state);
                return read;
              }),
          );
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
              cause instanceof BranchMissingError)
          )
            throw new ThreadPeerPullLost(identity.peerBranchId, identity.upstreamBranchId, cause);
          throw cause;
        }
      });
    },
  };

  async function pullPeerFromCapturedUpstream(
    lease: BranchLockLease,
    peerBranchId: string,
    upstreamState: Uint8Array,
  ): Promise<Uint8Array> {
    const upstreamDoc = docFromSnapshot(upstreamState);
    try {
      return await input.branchCoordinator.pullFromDoc(lease, peerBranchId, upstreamDoc);
    } finally {
      upstreamDoc.destroy();
    }
  }
}

function docFromSnapshot(snapshot: Uint8Array): Y.Doc {
  return yjsUpdateFromState(snapshot);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled pull outcome ${JSON.stringify(value)}`);
}
