/** Tests for Hocuspocus branch-room persistence guards. */
import type { UpdateJournal } from "@meridian/agent-edit";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BranchSnapshot } from "./domain/branch-coordinator.js";
import { BranchStaleUpdateError } from "./domain/branch-coordinator.js";
import { createHocuspocusPersistenceService } from "./hocuspocus-persistence.js";

const BRANCH_ID = "branch-1";
const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001" as never;

describe("createHocuspocusPersistenceService branch stale gate", () => {
  it("accepts a first writer update when the branch state carries tombstones already present in the room doc", async () => {
    const branchDoc = tombstoneBearingDoc();
    const snapshot = branchSnapshot(branchDoc);
    const roomDoc = cloneDoc(branchDoc);
    const before = Y.encodeStateVector(roomDoc);
    roomDoc.getText("content").insert(roomDoc.getText("content").length, "!");
    const humanUpdate = Y.encodeStateAsUpdate(roomDoc, before);
    const commitUpdate = vi.fn(async () => undefined);
    const persistence = createHocuspocusPersistenceService({
      journal: fakeJournal(),
      branchStore: { getBranch: async () => snapshot, updateBranchSnapshot: async () => true },
      branchCoordinator: {
        commitUpdate,
      } as never,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });

    await expect(
      persistence.persistBranchConnectionUpdate({
        branchId: BRANCH_ID,
        expectedGeneration: 2,
        update: humanUpdate,
        origin: { type: "user", userId: "user-1" as never },
        document: roomDoc,
      }),
    ).resolves.toBeUndefined();

    expect(commitUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: BRANCH_ID, updateData: humanUpdate }),
    );
  });

  it("rejects a stale room doc that lacks the branch tombstone delete set", async () => {
    const snapshot = branchSnapshot(tombstoneBearingDoc());
    const staleRoomDoc = docWithText("seed");
    const before = Y.encodeStateVector(staleRoomDoc);
    staleRoomDoc.getText("content").insert(4, "!");
    const staleUpdate = Y.encodeStateAsUpdate(staleRoomDoc, before);
    const persistence = createHocuspocusPersistenceService({
      journal: fakeJournal(),
      branchStore: { getBranch: async () => snapshot, updateBranchSnapshot: async () => true },
      branchCoordinator: {
        commitUpdate: vi.fn(async () => undefined),
      } as never,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });

    await expect(
      persistence.persistBranchConnectionUpdate({
        branchId: BRANCH_ID,
        expectedGeneration: 2,
        update: staleUpdate,
        origin: { type: "user", userId: "user-1" as never },
        document: staleRoomDoc,
      }),
    ).rejects.toThrow(BranchStaleUpdateError);
  });

  it("fences a retained stale client at the branch SyncStep1 handshake", async () => {
    const discardedDoc = tombstoneBearingDoc();
    discardedDoc.getText("content").insert(discardedDoc.getText("content").length, " stale");
    const currentDoc = docWithText("current generation");
    const snapshot = {
      ...branchSnapshot(currentDoc),
      generation: 3,
      discardedStateVector: Y.encodeStateVector(discardedDoc),
    };
    const persistence = createHocuspocusPersistenceService({
      journal: fakeJournal(),
      branchStore: { getBranch: async () => snapshot, updateBranchSnapshot: async () => true },
      branchCoordinator: { commitUpdate: vi.fn(async () => undefined) } as never,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });

    await expect(
      persistence.rejectStaleBranchSyncStep1({
        branchId: BRANCH_ID,
        generation: 3,
        clientStateVector: Y.encodeStateVector(discardedDoc),
      }),
    ).resolves.toBe(true);
  });

  it("accepts fresh post-reset client structs above the discarded range", async () => {
    const discardedDoc = tombstoneBearingDoc();
    const currentDoc = docWithText("current generation");
    const snapshot = {
      ...branchSnapshot(currentDoc),
      generation: 3,
      discardedStateVector: Y.encodeStateVector(discardedDoc),
    };
    const roomDoc = cloneDoc(currentDoc);
    const before = Y.encodeStateVector(roomDoc);
    roomDoc.getText("content").insert(roomDoc.getText("content").length, " fresh");
    const freshUpdate = Y.encodeStateAsUpdate(roomDoc, before);
    const commitUpdate = vi.fn(async () => undefined);
    const persistence = createHocuspocusPersistenceService({
      journal: fakeJournal(),
      branchStore: { getBranch: async () => snapshot, updateBranchSnapshot: async () => true },
      branchCoordinator: { commitUpdate } as never,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });

    await expect(
      persistence.persistBranchConnectionUpdate({
        branchId: BRANCH_ID,
        expectedGeneration: 3,
        update: freshUpdate,
        origin: { type: "user", userId: "user-1" as never },
        document: roomDoc,
      }),
    ).resolves.toBeUndefined();

    expect(commitUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ branchId: BRANCH_ID, updateData: freshUpdate }),
    );
  });

  it("does not fence a never-reset branch", async () => {
    const currentDoc = docWithText("current generation");
    const snapshot = { ...branchSnapshot(currentDoc), generation: 3 };
    const staleDoc = cloneDoc(currentDoc);
    staleDoc.getText("content").insert(staleDoc.getText("content").length, " stale");
    const persistence = createHocuspocusPersistenceService({
      journal: fakeJournal(),
      branchStore: { getBranch: async () => snapshot, updateBranchSnapshot: async () => true },
      branchCoordinator: { commitUpdate: vi.fn(async () => undefined) } as never,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });

    await expect(
      persistence.rejectStaleBranchSyncStep1({
        branchId: BRANCH_ID,
        generation: 3,
        clientStateVector: Y.encodeStateVector(staleDoc),
      }),
    ).resolves.toBe(false);
  });
});
function tombstoneBearingDoc(): Y.Doc {
  const doc = docWithText("seed");
  const text = doc.getText("content");
  text.delete(0, text.length);
  text.insert(0, "seed replaced");
  return doc;
}

function docWithText(text: string): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  doc.getText("content").insert(0, text);
  return doc;
}

function cloneDoc(doc: Y.Doc): Y.Doc {
  const clone = new Y.Doc({ gc: false });
  Y.applyUpdate(clone, Y.encodeStateAsUpdate(doc));
  return clone;
}

function branchSnapshot(doc: Y.Doc): BranchSnapshot {
  return {
    branchId: BRANCH_ID,
    documentId: DOCUMENT_ID,
    kind: "work_draft",
    upstreamBranchId: null,
    workId: "work-1" as never,
    threadId: null,
    pushPolicy: "manual",
    status: "active",
    generation: 2,
    state: Y.encodeStateAsUpdate(doc),
    stateVector: Y.encodeStateVector(doc),
    schemaVersion: 1,
  };
}

function fakeJournal(): UpdateJournal {
  return {
    append: vi.fn(async () => 1),
    appendBatch: vi.fn(async () => []),
    read: vi.fn(async () => ({ checkpoint: null, updates: [] })),
    checkpoint: vi.fn(async () => undefined),
    compact: vi.fn(async () => ({ updatesFolded: 0, reversalsExpired: 0 })),
  };
}
