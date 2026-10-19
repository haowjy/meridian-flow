/** Debounced parent-to-child draft pulls for shadow-mode draft peers. */

import {
  type DocumentCoordinator,
  type UpdateJournal,
  yjsUpdateFromState,
} from "@meridian/agent-edit/integration";
import type { BranchId } from "@meridian/contracts";
import type { DocumentId, ThreadId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import { collabHook } from "./collab-test-hooks.js";
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
  /**
   * Live merged into one work draft, answered for that draft: the projection job's way to
   * establish a legacy draft's baseline (design §3.3). Deleted with the null-baseline arm.
   */
  pullWorkDraft(input: { documentId: DocumentId; draftId: string }): Promise<PullOutcome>;
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
  liveJournal?: Pick<UpdateJournal, "read">;
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
    // A missing or removed document is never an empty upstream: nothing pulls it.
    const state = await input.outsideTransaction(() =>
      input.liveCoordinator.withDocument(documentId, async (liveDoc) =>
        Y.encodeStateAsUpdate(liveDoc),
      ),
    );
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
            await collabHook("draft.beforeAccess");
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
