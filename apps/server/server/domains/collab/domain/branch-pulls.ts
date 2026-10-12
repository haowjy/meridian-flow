/** Debounced parent-to-child branch pulls for shadow-mode branch peers. */

import {
  type DocumentCoordinator,
  DocumentNotFoundError,
  type ReversalStore,
  yjsUpdateFromState,
} from "@meridian/agent-edit/integration";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import type { BranchConcurrentJournalWatermarks } from "./branch-agent-edit.js";
import type { BranchCoordinator } from "./branch-coordinator.js";
import { runOutsideResponseTransaction } from "./response-transaction.js";

export type WorkDraftLookup = {
  listActiveWorkDraftBranchIds(documentId: DocumentId): Promise<string[]>;
  ensureWorkDraftBranch(input: {
    documentId: DocumentId;
    workId: WorkId;
    liveDoc: Y.Doc;
  }): Promise<{ branchId: string }>;
  ensureThreadPeerBranch(input: {
    documentId: DocumentId;
    threadId: ThreadId;
    liveDoc: Y.Doc;
  }): Promise<{ branchId: string }>;
};

export type BranchPullService = {
  scheduleLivePull(documentId: DocumentId): void;
  /** Drops debounced pulls that haven't started; in-flight pulls finish. */
  cancelScheduledPulls(): void;
  flushLivePull(documentId: DocumentId): Promise<void>;
  pullThreadPeer(input: { documentId: DocumentId; threadId: ThreadId }): Promise<{
    branchGeneration: number;
    afterJournalId?: number;
    liveJournalSeq?: number;
    attributionBaseline: Uint8Array;
  }>;
};

export type BranchPullDiagnostics = {
  backgroundFailed(input: { documentId: DocumentId; cause: unknown }): void;
};

export function createBranchPullService(input: {
  outsideTransaction<T>(operation: () => T): T;
  rootTransaction<T>(operation: () => Promise<T>): Promise<T>;
  liveCoordinator: DocumentCoordinator;
  branchCoordinator: BranchCoordinator;
  branches: WorkDraftLookup;
  debounceMs?: number;
  maxDebounceMs?: number;
  concurrentJournalWatermarks?: BranchConcurrentJournalWatermarks;
  liveJournal?: Pick<ReversalStore, "readForReconstruction">;
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

  async function pullLive(documentId: DocumentId): Promise<void> {
    // Most documents have no Work draft; skip the snapshot (a room open and
    // release) for them. The root transaction re-lists: a branch can close in
    // between, and one opened since waits for the next pull.
    if ((await input.branches.listActiveWorkDraftBranchIds(documentId)).length === 0) return;
    // Snapshot before the root transaction opens: the snapshot takes its own
    // connection, and taking it while holding the root's lets concurrent pulls
    // hold every pooled connection and wait on each other forever.
    const liveDoc = await liveSnapshot(documentId);
    try {
      await input.rootTransaction(async () => {
        for (const branchId of await input.branches.listActiveWorkDraftBranchIds(documentId)) {
          await input.branchCoordinator.pullFromDoc(branchId, liveDoc);
        }
      });
    } finally {
      liveDoc.destroy();
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

  return {
    scheduleLivePull(documentId) {
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
        const beforePullLive = await liveSnapshot(inputPeer.documentId);
        const attributionBaseline = await (async () => {
          try {
            const existingPeer = await input.branches.ensureThreadPeerBranch({
              ...inputPeer,
              liveDoc: beforePullLive,
            });
            return input.branchCoordinator.readBranch(existingPeer.branchId, (doc) =>
              Promise.resolve(Y.encodeStateAsUpdate(doc)),
            );
          } finally {
            beforePullLive.destroy();
          }
        })();
        await run(inputPeer.documentId);
        const liveJournalSeq = input.liveJournal
          ? (await input.liveJournal.readForReconstruction(inputPeer.documentId)).updates.reduce(
              (latest, update) => Math.max(latest, update.seq),
              0,
            )
          : undefined;
        const liveDoc = await liveSnapshot(inputPeer.documentId);
        try {
          const peer = await input.branches.ensureThreadPeerBranch({ ...inputPeer, liveDoc });
          const captured = await input.branchCoordinator.readBranch(
            peer.branchId,
            (_doc, snapshot) =>
              Promise.resolve({
                peerGeneration: snapshot?.generation,
                upstreamBranchId: snapshot?.upstreamBranchId,
              }),
          );
          const afterJournalId = input.concurrentJournalWatermarks?.current(
            inputPeer.threadId,
            inputPeer.documentId,
          );
          const upstream = captured.upstreamBranchId
            ? await input.branchCoordinator.readBranch(captured.upstreamBranchId, (doc, snapshot) =>
                Promise.resolve({
                  generation: snapshot.generation,
                  state: Y.encodeStateAsUpdate(doc),
                }),
              )
            : undefined;
          await input.rootTransaction(async () => {
            if (upstream) await pullPeerFromCapturedUpstream(peer.branchId, upstream.state);
            else await input.branchCoordinator.pullFromBranch(peer.branchId);
          });
          const branchGeneration = upstream?.generation ?? captured.peerGeneration;
          return { branchGeneration, afterJournalId, liveJournalSeq, attributionBaseline };
        } finally {
          liveDoc.destroy();
        }
      });
    },
  };

  async function pullPeerFromCapturedUpstream(
    peerBranchId: string,
    upstreamState: Uint8Array,
  ): Promise<Uint8Array> {
    const upstreamDoc = docFromSnapshot(upstreamState);
    try {
      return await input.branchCoordinator.pullFromDoc(peerBranchId, upstreamDoc);
    } finally {
      upstreamDoc.destroy();
    }
  }
}

function docFromSnapshot(snapshot: Uint8Array): Y.Doc {
  return yjsUpdateFromState(snapshot);
}
