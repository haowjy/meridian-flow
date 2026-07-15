/** Tests for Hocuspocus branch-room persistence guards. */
import type { UpdateJournal } from "@meridian/agent-edit";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BranchSnapshot } from "./domain/branch-coordinator.js";
import { BranchStaleUpdateError } from "./domain/branch-coordinator.js";
import { PROVENANCE_ROOTS_TYPE, PROVENANCE_TARGETS_TYPE } from "./domain/provenance.js";
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
      branchStore: {
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: async () => snapshot,
        updateBranchSnapshot: async () => true,
      },
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
      branchStore: {
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: async () => snapshot,
        updateBranchSnapshot: async () => true,
      },
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
      branchStore: {
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: async () => snapshot,
        updateBranchSnapshot: async () => true,
      },
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
      branchStore: {
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: async () => snapshot,
        updateBranchSnapshot: async () => true,
      },
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
      branchStore: {
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: async () => snapshot,
        updateBranchSnapshot: async () => true,
      },
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

describe("createHocuspocusPersistenceService writer ingress", () => {
  it("disconnects the retired live generation and rejects its replayed bytes", async () => {
    const checkpoint = docWithText("checkpoint");
    const retired = cloneDoc(checkpoint);
    const retiredVector = Y.encodeStateVector(retired);
    retired.getText("content").insert(retired.getText("content").length, " retired");
    const retiredUpdate = Y.encodeStateAsUpdate(retired, retiredVector);
    const documents = new Map<string, Y.Doc>([[DOCUMENT_ID, retired]]);
    const closeConnections = vi.fn();
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(async () => ({ seq: 1, joinedSettlement: false }));
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => ({ documents, closeConnections }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });

    await persistence.disconnectLiveGeneration(DOCUMENT_ID, 1n);
    expect(closeConnections).toHaveBeenCalledWith(DOCUMENT_ID);
    expect(documents.has(DOCUMENT_ID)).toBe(false);

    documents.set(DOCUMENT_ID, checkpoint);
    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        update: retiredUpdate,
        origin: { type: "user", userId: "user-1" },
      }),
    ).rejects.toThrow("stale-authority-generation");
    expect(journal.appendWriterUpdate).not.toHaveBeenCalled();
  });

  it("admits fresh client bytes after a generation replacement", async () => {
    const retired = docWithText("retired");
    const documents = new Map<string, Y.Doc>([[DOCUMENT_ID, retired]]);
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(async () => ({ seq: 1, joinedSettlement: false }));
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => ({ documents, closeConnections: vi.fn() }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });
    await persistence.disconnectLiveGeneration(DOCUMENT_ID, 1n);
    const current = docWithText("checkpoint");
    documents.set(DOCUMENT_ID, current);
    const client = cloneDoc(current);
    const before = Y.encodeStateVector(client);
    client.getText("content").insert(client.getText("content").length, " fresh");

    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        update: Y.encodeStateAsUpdate(client, before),
        origin: { type: "user", userId: "user-1" },
      }),
    ).resolves.toEqual({ joinedSettlement: false });
  });

  it.each([
    ["ordinary-client overwrite", (doc: Y.Doc) => doc.getArray(PROVENANCE_TARGETS_TYPE).push([{}])],
    [
      "nested insert",
      (doc: Y.Doc) =>
        (doc.getArray(PROVENANCE_TARGETS_TYPE).get(0) as Y.Array<unknown>).push(["hostile"]),
    ],
    ["delete-only change", (doc: Y.Doc) => doc.getArray(PROVENANCE_TARGETS_TYPE).delete(0, 1)],
    ["top-level collision", (doc: Y.Doc) => doc.getMap(PROVENANCE_ROOTS_TYPE).set("x", 1)],
    [
      "conflicting append-only fact",
      (doc: Y.Doc) => doc.getArray(PROVENANCE_TARGETS_TYPE).push([{ root: "other" }]),
    ],
  ])("rejects hostile reserved namespace %s before journaling", async (_name, mutate) => {
    const authority = reservedAuthorityDoc();
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(async () => ({ seq: 1, joinedSettlement: false }));
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => ({ documents: new Map([[DOCUMENT_ID, authority]]) }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });
    const client = cloneDoc(authority);
    const vector = Y.encodeStateVector(client);
    mutate(client);

    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        update: Y.encodeStateAsUpdate(client, vector),
        origin: { type: "user", userId: "user-1" },
      }),
    ).rejects.toThrow();
    expect(journal.appendWriterUpdate).not.toHaveBeenCalled();
  });

  it("rejects reserved-client-ID injection before journaling", async () => {
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(async () => ({ seq: 1, joinedSettlement: false }));
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });
    const client = new Y.Doc();
    client.clientID = 999;
    client.getText("content").insert(0, "hostile");
    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        update: Y.encodeStateAsUpdate(client),
        origin: { type: "user", userId: "user-1" },
      }),
    ).rejects.toThrow("reserved-writer-client-id");
    expect(journal.appendWriterUpdate).not.toHaveBeenCalled();
  });

  it("does not resolve admission until the journal transaction commits", async () => {
    const events: string[] = [];
    let commit: (() => void) | undefined;
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(
      () =>
        new Promise<{ seq: number; joinedSettlement: boolean }>((resolve) => {
          events.push("journal:start");
          commit = () => {
            events.push("journal:commit");
            resolve({ seq: 1, joinedSettlement: true });
          };
        }),
    );
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });
    const update = writerUpdate();
    const admission = persistence
      .admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        update,
        origin: { type: "user", userId: "user-1" },
      })
      .then((result) => {
        events.push("apply/broadcast/ack");
        return result;
      });

    await Promise.resolve();
    expect(events).toEqual(["journal:start"]);
    commit?.();
    await expect(admission).resolves.toEqual({ joinedSettlement: true });
    expect(events).toEqual(["journal:start", "journal:commit", "apply/broadcast/ack"]);
  });

  it("rejects journal failure before the transport can apply or acknowledge", async () => {
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });
    let appliedOrAcknowledged = false;

    await expect(
      persistence
        .admitLiveWriterUpdate({
          documentId: DOCUMENT_ID,
          update: writerUpdate(),
          origin: { type: "user", userId: "user-1" },
        })
        .then(() => {
          appliedOrAcknowledged = true;
        }),
    ).rejects.toThrow("database unavailable");
    expect(appliedOrAcknowledged).toBe(false);
    expect(persistence.getPersistenceQueueMetrics().queues).toEqual([
      expect.objectContaining({ documentId: DOCUMENT_ID, dropped: 1 }),
    ]);
  });

  it("drains started admissions and detects a later generation", async () => {
    const resolvers: Array<() => void> = [];
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(
      () =>
        new Promise<{ seq: number; joinedSettlement: boolean }>((resolve) => {
          resolvers.push(() => resolve({ seq: resolvers.length, joinedSettlement: false }));
        }),
    );
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });
    const first = persistence.admitLiveWriterUpdate({
      documentId: DOCUMENT_ID,
      update: writerUpdate(),
      origin: { type: "user", userId: "user-1" },
    });
    const drain = persistence.writerIngressBarrier.drain(DOCUMENT_ID);
    resolvers[0]?.();
    const generation = await drain;
    await first;
    expect(persistence.writerIngressBarrier.isGenerationCurrent(DOCUMENT_ID, generation)).toBe(
      true,
    );

    const second = persistence.admitLiveWriterUpdate({
      documentId: DOCUMENT_ID,
      update: writerUpdate(),
      origin: { type: "user", userId: "user-1" },
    });
    expect(persistence.writerIngressBarrier.isGenerationCurrent(DOCUMENT_ID, generation)).toBe(
      false,
    );
    resolvers[1]?.();
    await second;
  });
});

function writerUpdate(): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, "writer");
  return Y.encodeStateAsUpdate(doc);
}

function reservedAuthorityDoc(): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  const nested = new Y.Array<unknown>();
  doc.getArray(PROVENANCE_TARGETS_TYPE).push([nested]);
  nested.push(["authority fact"]);
  return doc;
}
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
