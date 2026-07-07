/** Debounced parent-to-child branch pulls for shadow-mode branch peers. */

import {
  type DocumentCoordinator,
  DocumentNotFoundError,
  yjsUpdateChangesDoc,
  yjsUpdateFromState,
} from "@meridian/agent-edit";
import type { DocumentId, ThreadId, WorkId } from "@meridian/contracts/runtime";
import * as Y from "yjs";
import type { BranchConcurrentJournalWatermarks } from "./branch-agent-edit.js";
import type { BranchCoordinator } from "./branch-coordinator.js";

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
  flushLivePull(documentId: DocumentId): Promise<void>;
  pullThreadPeer(input: { documentId: DocumentId; threadId: ThreadId }): Promise<{
    changed: boolean;
    baselineSnapshot?: Uint8Array;
    branchGeneration: number;
    afterJournalId?: number;
  }>;
};

export function createBranchPullService(input: {
  liveCoordinator: DocumentCoordinator;
  branchCoordinator: BranchCoordinator;
  branches: WorkDraftLookup;
  debounceMs?: number;
  maxDebounceMs?: number;
  concurrentJournalWatermarks?: BranchConcurrentJournalWatermarks;
}): BranchPullService {
  const debounceMs = input.debounceMs ?? 2000;
  const maxDebounceMs = input.maxDebounceMs ?? 10000;
  const timers = new Map<
    string,
    { debounce?: NodeJS.Timeout; max?: NodeJS.Timeout; running?: Promise<void>; rerun?: boolean }
  >();

  function clear(documentId: string): void {
    const entry = timers.get(documentId);
    if (!entry) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    if (entry.max) clearTimeout(entry.max);
    timers.delete(documentId);
  }

  async function liveSnapshot(documentId: DocumentId): Promise<Y.Doc> {
    const state = await input.liveCoordinator
      .withDocument(documentId, async (liveDoc) => Y.encodeStateAsUpdate(liveDoc))
      .catch((cause: unknown) => {
        if (cause instanceof DocumentNotFoundError)
          return Y.encodeStateAsUpdate(new Y.Doc({ gc: false }));
        throw cause;
      });
    const doc = new Y.Doc({ gc: false });
    Y.applyUpdate(doc, state);
    return doc;
  }

  async function run(documentId: DocumentId): Promise<void> {
    const current = timers.get(documentId);
    if (current?.running) {
      current.rerun = true;
      return current.running;
    }
    const running = (async () => {
      clear(documentId);
      const liveDoc = await liveSnapshot(documentId);
      try {
        for (const branchId of await input.branches.listActiveWorkDraftBranchIds(documentId)) {
          await input.branchCoordinator.pullFromDoc(branchId, liveDoc);
        }
      } finally {
        liveDoc.destroy();
      }
    })().finally(() => {
      const entry = timers.get(documentId);
      if (entry?.running !== running) return;
      if (entry.rerun) {
        entry.running = undefined;
        entry.rerun = false;
        void run(documentId).catch((cause: unknown) => {
          console.error("Branch live-pull rerun failed", { documentId, cause });
        });
      } else {
        timers.delete(documentId);
      }
    });
    timers.set(documentId, { running });
    return running;
  }

  return {
    scheduleLivePull(documentId) {
      const entry = timers.get(documentId) ?? {};
      if (entry.debounce) clearTimeout(entry.debounce);
      entry.debounce = setTimeout(() => void run(documentId), debounceMs);
      entry.max ??= setTimeout(() => void run(documentId), maxDebounceMs);
      timers.set(documentId, entry);
    },

    flushLivePull(documentId) {
      return run(documentId);
    },

    async pullThreadPeer(inputPeer) {
      await run(inputPeer.documentId);
      const liveDoc = await liveSnapshot(inputPeer.documentId);
      try {
        const peer = await input.branches.ensureThreadPeerBranch({ ...inputPeer, liveDoc });
        const captured = await input.branchCoordinator.readBranch(peer.branchId, (doc, snapshot) =>
          Promise.resolve({
            snapshot: Y.encodeStateAsUpdate(doc),
            peerGeneration: snapshot?.generation,
            upstreamBranchId: snapshot?.upstreamBranchId,
          }),
        );
        const baselineSnapshot = captured.snapshot;
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
        const update = upstream
          ? await pullPeerFromCapturedUpstream(peer.branchId, upstream.state)
          : await input.branchCoordinator.pullFromBranch(peer.branchId);
        const branchGeneration = upstream?.generation ?? captured.peerGeneration;
        const baselineDoc = docFromSnapshot(baselineSnapshot);
        try {
          const changed = updateChangesDoc(baselineDoc, update);
          return {
            changed,
            branchGeneration,
            afterJournalId,
            ...(changed ? { baselineSnapshot } : {}),
          };
        } finally {
          baselineDoc.destroy();
        }
      } finally {
        liveDoc.destroy();
      }
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

function updateChangesDoc(doc: Y.Doc, update: Uint8Array): boolean {
  return yjsUpdateChangesDoc(doc, update);
}
