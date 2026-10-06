/** Tests for Hocuspocus room persistence: branch guards and deferred live checkpoints. */

import { Hocuspocus } from "@hocuspocus/server";
import type { UpdateJournal } from "@meridian/agent-edit/integration";
import { COLLAB_SCHEMA_VERSION } from "@meridian/prosemirror-schema";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { RecentEventsBuffer } from "../observability/adapters/recent/recent-events-buffer.js";
import type { BranchSnapshot } from "./domain/branch-coordinator.js";
import { BranchStaleUpdateError } from "./domain/branch-coordinator.js";
import { createBranchCriticalSections } from "./domain/branch-critical-sections.js";
import {
  bindDocumentAuthority,
  documentAuthority,
  RetiredDocumentHandleError,
} from "./domain/document-handle.js";
import { PROVENANCE_TARGETS_TYPE, ReservedNamespaceAdmissionError } from "./domain/provenance.js";
import { createHocuspocusPersistenceService } from "./hocuspocus-persistence.js";
import { unimplementedBranchMutations } from "./test-support/unimplemented-branch-mutations.js";

const BRANCH_ID = "branch-1";
const DOCUMENT_ID = "00000000-0000-4000-8000-000000000001" as never;

describe("createHocuspocusPersistenceService branch room storage", () => {
  it("refuses a room whose load hooks finish after a restore and opens the current generation", async () => {
    let generation = 1n;
    let finishLoad!: () => void;
    let reachedAfterLoad!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reachedAfterLoad = resolve;
    });
    const journal = fakeJournal();
    journal.read = async () => ({
      authority: { authorityId: "test-authority", generation },
      checkpoint: Y.encodeStateAsUpdate(new Y.Doc()),
      updates: [],
    });
    const hp = new Hocuspocus({
      async onLoadDocument({ document }) {
        const state = await persistence.loadHocuspocusDocument(DOCUMENT_ID, document);
        if (state) Y.applyUpdate(document, state);
      },
      async afterLoadDocument({ document }) {
        if (documentAuthority(document).generation === 1n) {
          reachedAfterLoad();
          await gate;
        }
        await persistence.validateHocuspocusDocument(DOCUMENT_ID, document);
      },
    });
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => hp,
      readAuthorityHeadGeneration: async () => generation,
      metaForOrigin: () => ({ origin: "system", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => {},
    });
    const loading = hp.openDirectConnection(DOCUMENT_ID, {}).catch((cause: unknown) => cause);
    await ready;
    expect(hp.documents.has(DOCUMENT_ID)).toBe(false);
    expect(hp.loadingDocuments.has(DOCUMENT_ID)).toBe(true);
    generation = 2n;
    await persistence.disconnectLiveGeneration(DOCUMENT_ID, 1n);
    finishLoad();
    expect(await loading).toBeInstanceOf(RetiredDocumentHandleError);
    expect(hp.documents.has(DOCUMENT_ID)).toBe(false);
    const current = await hp.openDirectConnection(DOCUMENT_ID, {});
    if (!current.document) throw new Error("Current room did not load");
    expect(documentAuthority(current.document).generation).toBe(2n);
    await persistence.disconnectLiveGeneration(DOCUMENT_ID, 1n);
    expect(hp.documents.get(DOCUMENT_ID)).toBe(current.document);
    expect(documentAuthority(current.document).generation).toBe(2n);
    await current.disconnect();
  });

  it("does not re-enter the coordinator lock after a durable room publication", async () => {
    const criticalSections = createBranchCriticalSections();
    const checkpointBranch = vi.fn(() =>
      criticalSections.withBranches([BRANCH_ID], async () => undefined),
    );
    const persistence = createHocuspocusPersistenceService({
      journal: fakeJournal(),
      branchCoordinator: { checkpointBranch } as never,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });

    await expect(
      criticalSections.withBranches([BRANCH_ID], () =>
        persistence.storeHocuspocusBranch(BRANCH_ID, boundDoc({ gc: false })),
      ),
    ).resolves.toBeUndefined();
    expect(checkpointBranch).not.toHaveBeenCalled();
  });

  it("registers branch admission before validation so store and shutdown drains wait", async () => {
    let releaseAdmission: (() => void) | undefined;
    const admissionBlocked = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const commitWriterUpdate = vi.fn(async () => admissionBlocked);
    const persistence = createHocuspocusPersistenceService({
      journal: fakeJournal(),
      branchCoordinator: { commitWriterUpdate } as never,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });

    const admission = persistence.admitBranchWriterUpdate({
      branchId: BRANCH_ID,
      expectedGeneration: 2,
      update: writerUpdate(),
      origin: { type: "user", userId: "user-1" as never },
      document: boundDoc({ gc: false }),
    });
    const store = persistence.storeHocuspocusBranch(BRANCH_ID, boundDoc({ gc: false }));
    const shutdownDrain = persistence.drainHocuspocusPersistence();
    let drained = false;
    void Promise.all([store, shutdownDrain]).then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseAdmission?.();
    await expect(Promise.all([admission, store, shutdownDrain])).resolves.toBeDefined();
    expect(commitWriterUpdate).toHaveBeenCalledOnce();
    expect(drained).toBe(true);
  });
});

describe("createHocuspocusPersistenceService live checkpoints", () => {
  function liveCheckpointFixture(input: { checkpoint?: UpdateJournal["checkpoint"] } = {}) {
    const journal = fakeJournal();
    if (input.checkpoint) journal.checkpoint = vi.fn(input.checkpoint);
    // Stands in for the caller's DB transaction: commit runs the queued
    // callbacks, rollback drops them.
    let queued: Array<() => void> = [];
    const documents = new Map<string, Y.Doc>();
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => ({ documents, closeConnections: vi.fn() }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 7,
      afterCallerCommit: (callback) => {
        queued.push(callback);
      },
      emitAgentEditInvariantViolation: () => undefined,
    });
    return {
      journal,
      documents,
      persistence,
      commit() {
        const callbacks = queued;
        queued = [];
        for (const callback of callbacks) callback();
      },
    };
  }

  it("returns without writing, then checkpoints after the caller commits", async () => {
    const fixture = liveCheckpointFixture();
    const doc = docWithText("stored");

    await fixture.persistence.storeHocuspocusDocument(DOCUMENT_ID, doc);
    await fixture.persistence.drainHocuspocusPersistence();
    expect(fixture.journal.checkpoint).not.toHaveBeenCalled();

    fixture.commit();
    await fixture.persistence.drainHocuspocusPersistence();
    expect(fixture.journal.checkpoint).toHaveBeenCalledExactlyOnceWith(
      DOCUMENT_ID,
      Y.encodeStateAsUpdate(doc),
      7,
      { authorityId: "test-authority", generation: 1n },
    );
  });

  it("skips a checkpoint whose live generation was retired before it ran", async () => {
    const fixture = liveCheckpointFixture();
    const doc = docWithText("retired");
    fixture.documents.set(DOCUMENT_ID, doc);

    await fixture.persistence.storeHocuspocusDocument(DOCUMENT_ID, doc);
    await fixture.persistence.disconnectLiveGeneration(DOCUMENT_ID, 1n);
    fixture.commit();
    await fixture.persistence.drainHocuspocusPersistence();
    expect(fixture.journal.checkpoint).not.toHaveBeenCalled();
  });

  it("writes one checkpoint at a time and keeps only the newest queued snapshot", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const fixture = liveCheckpointFixture({
      checkpoint: async () => {
        calls += 1;
        if (calls === 1) await firstBlocked;
      },
    });
    const first = docWithText("first");
    const second = docWithText("second");
    const third = docWithText("third");

    await fixture.persistence.storeHocuspocusDocument(DOCUMENT_ID, first);
    fixture.commit();
    await fixture.persistence.storeHocuspocusDocument(DOCUMENT_ID, second);
    await fixture.persistence.storeHocuspocusDocument(DOCUMENT_ID, third);
    fixture.commit();
    expect(fixture.journal.checkpoint).toHaveBeenCalledOnce();

    releaseFirst?.();
    await fixture.persistence.drainHocuspocusPersistence();
    expect(fixture.journal.checkpoint).toHaveBeenCalledTimes(2);
    expect(fixture.journal.checkpoint).toHaveBeenLastCalledWith(
      DOCUMENT_ID,
      Y.encodeStateAsUpdate(third),
      7,
      { authorityId: "test-authority", generation: 1n },
    );
  });
});

describe("createHocuspocusPersistenceService branch stale gate", () => {
  it("rejects reserved namespace smuggling before the branch journal commit", async () => {
    const branchDocument = documentWithReservedFacts();
    const client = cloneDoc(branchDocument);
    const before = Y.encodeStateVector(client);
    client.getArray(PROVENANCE_TARGETS_TYPE).delete(0, 1);
    const commitWriterUpdate = vi.fn(async () => {
      throw new ReservedNamespaceAdmissionError();
    });
    const persistence = createHocuspocusPersistenceService({
      journal: fakeJournal(),
      branchStore: {
        ...unimplementedBranchMutations(),
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: async () => branchSnapshot(branchDocument),
        updateBranchSnapshot: async () => true,
      },
      branchCoordinator: { commitWriterUpdate } as never,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });

    await expect(
      persistence.admitBranchWriterUpdate({
        branchId: BRANCH_ID,
        expectedGeneration: 2,
        update: Y.encodeStateAsUpdate(client, before),
        origin: { type: "user", userId: "user-1" as never },
        document: client,
      }),
    ).rejects.toBeInstanceOf(ReservedNamespaceAdmissionError);
    expect(commitWriterUpdate).toHaveBeenCalledOnce();
  });

  it("accepts a first writer update when the branch state carries tombstones already present in the room doc", async () => {
    const branchDoc = tombstoneBearingDoc();
    const snapshot = branchSnapshot(branchDoc);
    const roomDoc = cloneDoc(branchDoc);
    const before = Y.encodeStateVector(roomDoc);
    roomDoc.getText("content").insert(roomDoc.getText("content").length, "!");
    const humanUpdate = Y.encodeStateAsUpdate(roomDoc, before);
    const commitWriterUpdate = vi.fn(async () => undefined);
    const persistence = createHocuspocusPersistenceService({
      journal: fakeJournal(),
      branchStore: {
        ...unimplementedBranchMutations(),
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: async () => snapshot,
        updateBranchSnapshot: async () => true,
      },
      branchCoordinator: {
        commitWriterUpdate,
      } as never,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });

    await expect(
      persistence.admitBranchWriterUpdate({
        branchId: BRANCH_ID,
        expectedGeneration: 2,
        update: humanUpdate,
        origin: { type: "user", userId: "user-1" as never },
        document: roomDoc,
      }),
    ).resolves.toBeUndefined();

    expect(commitWriterUpdate).toHaveBeenCalledWith(
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
        ...unimplementedBranchMutations(),
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: async () => snapshot,
        updateBranchSnapshot: async () => true,
      },
      branchCoordinator: {
        commitWriterUpdate: vi.fn(async () => {
          throw new BranchStaleUpdateError(BRANCH_ID);
        }),
      } as never,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });

    await expect(
      persistence.admitBranchWriterUpdate({
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
        ...unimplementedBranchMutations(),
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: async () => snapshot,
        updateBranchSnapshot: async () => true,
      },
      branchCoordinator: { commitWriterUpdate: vi.fn(async () => undefined) } as never,
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
    const commitWriterUpdate = vi.fn(async () => undefined);
    const persistence = createHocuspocusPersistenceService({
      journal: fakeJournal(),
      branchStore: {
        ...unimplementedBranchMutations(),
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: async () => snapshot,
        updateBranchSnapshot: async () => true,
      },
      branchCoordinator: { commitWriterUpdate } as never,
      hocuspocus: () => null,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });

    await expect(
      persistence.admitBranchWriterUpdate({
        branchId: BRANCH_ID,
        expectedGeneration: 3,
        update: freshUpdate,
        origin: { type: "user", userId: "user-1" as never },
        document: roomDoc,
      }),
    ).resolves.toBeUndefined();

    expect(commitWriterUpdate).toHaveBeenCalledWith(
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
        ...unimplementedBranchMutations(),
        deferUntilCommit: (callback) => {
          callback();
          return true;
        },
        getBranch: async () => snapshot,
        updateBranchSnapshot: async () => true,
      },
      branchCoordinator: { commitWriterUpdate: vi.fn(async () => undefined) } as never,
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
  it("suppresses contained reconnect updates without advancing writer ingress", async () => {
    const liveDocument = tombstoneBearingDoc();
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(async () => ({ seq: 1, joinedSettlement: false }));
    const onLiveUpdatePersisted = vi.fn();
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => ({ documents: new Map([[DOCUMENT_ID, liveDocument]]) }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
      onLiveUpdatePersisted,
    });
    const ingressGeneration = await persistence.writerIngressBarrier.drain(DOCUMENT_ID);
    const fullState = Y.encodeStateAsUpdate(liveDocument);
    const containedDeleteSet = Y.diffUpdate(fullState, Y.encodeStateVector(liveDocument));
    expect(Y.decodeUpdate(containedDeleteSet).structs).toHaveLength(0);

    for (const update of [fullState, containedDeleteSet, new Uint8Array([0, 0])]) {
      await expect(
        persistence.admitLiveWriterUpdate({
          documentId: DOCUMENT_ID,
          document: liveDocument,
          update,
          origin: { type: "user", userId: "user-1" },
          expectedGeneration: 1n,
        }),
      ).resolves.toEqual({ admitted: false, joinedSettlement: false });
      expect(
        persistence.writerIngressBarrier.isGenerationCurrent(DOCUMENT_ID, ingressGeneration),
      ).toBe(true);
    }

    expect(journal.appendWriterUpdate).not.toHaveBeenCalled();
    expect(onLiveUpdatePersisted).not.toHaveBeenCalled();
  });

  it("admits novel insertion and delete-only updates", async () => {
    const liveDocument = tombstoneBearingDoc();
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(async () => ({ seq: 1, joinedSettlement: false }));
    const onLiveUpdatePersisted = vi.fn();
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => ({ documents: new Map([[DOCUMENT_ID, liveDocument]]) }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
      onLiveUpdatePersisted,
    });
    const insertionClient = cloneDoc(liveDocument);
    const beforeInsertion = Y.encodeStateVector(insertionClient);
    insertionClient.getText("content").insert(insertionClient.getText("content").length, "!");
    const insertion = Y.encodeStateAsUpdate(insertionClient, beforeInsertion);

    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document: liveDocument,
        update: insertion,
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 1n,
      }),
    ).resolves.toEqual({ admitted: true, joinedSettlement: false });

    const deletionClient = cloneDoc(liveDocument);
    const beforeDeletion = Y.encodeStateVector(deletionClient);
    deletionClient.getText("content").delete(0, 1);
    const deletion = Y.encodeStateAsUpdate(deletionClient, beforeDeletion);
    expect(Y.decodeUpdate(deletion).structs).toHaveLength(0);

    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document: liveDocument,
        update: deletion,
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 1n,
      }),
    ).resolves.toEqual({ admitted: true, joinedSettlement: false });

    expect(journal.appendWriterUpdate).toHaveBeenNthCalledWith(
      1,
      DOCUMENT_ID,
      insertion,
      expect.anything(),
      { authorityId: "test-authority", generation: 1n },
    );
    expect(journal.appendWriterUpdate).toHaveBeenNthCalledWith(
      2,
      DOCUMENT_ID,
      deletion,
      expect.anything(),
      { authorityId: "test-authority", generation: 1n },
    );
    expect(onLiveUpdatePersisted).toHaveBeenCalledTimes(2);
  });

  it("disconnects the retired live generation and rejects its replayed bytes", async () => {
    const checkpoint = docWithText("checkpoint", 2n);
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
        document: checkpoint,
        update: retiredUpdate,
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 1n,
      }),
    ).rejects.toThrow("stale-durable-authority-generation");
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
    const current = docWithText("checkpoint", 2n);
    documents.set(DOCUMENT_ID, current);
    const client = cloneDoc(current);
    const before = Y.encodeStateVector(client);
    client.getText("content").insert(client.getText("content").length, " fresh");

    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document: current,
        update: Y.encodeStateAsUpdate(client, before),
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 2n,
      }),
    ).resolves.toEqual({ admitted: true, joinedSettlement: false });
  });

  it("rejects a retained-identity delete-only replay without journaling or applying", async () => {
    const retired = docWithText("retained");
    const staleClient = cloneDoc(retired);
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
    const current = cloneDoc(retired, 2n);
    documents.set(DOCUMENT_ID, current);
    const beforeDelete = Y.encodeStateVector(staleClient);
    staleClient.getText("content").delete(0, staleClient.getText("content").length);
    const deleteOnly = Y.encodeStateAsUpdate(staleClient, beforeDelete);
    expect(Y.decodeUpdate(deleteOnly).structs).toHaveLength(0);

    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document: current,
        update: deleteOnly,
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 2n,
      }),
    ).rejects.toThrow("retired-durable-authority-generation");
    expect(journal.appendWriterUpdate).not.toHaveBeenCalled();
    expect(current.getText("content").toString()).toBe("retained");
  });

  it("rejects an update from a connection bound to the retired generation", async () => {
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

    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document: retired,
        update: writerUpdate(),
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 1n,
      }),
    ).rejects.toThrow("Document handle belongs to a retired authority generation");
    expect(journal.appendWriterUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["ordinary-client overwrite", (doc: Y.Doc) => doc.getArray(PROVENANCE_TARGETS_TYPE).push([{}])],
    [
      "nested insert",
      (doc: Y.Doc) =>
        (doc.getArray(PROVENANCE_TARGETS_TYPE).get(0) as Y.Array<unknown>).push(["hostile"]),
    ],
    ["delete-only change", (doc: Y.Doc) => doc.getArray(PROVENANCE_TARGETS_TYPE).delete(0, 1)],
    ["top-level collision", (doc: Y.Doc) => doc.getMap(PROVENANCE_TARGETS_TYPE).set("x", 1)],
    [
      "conflicting append-only fact",
      (doc: Y.Doc) => doc.getArray(PROVENANCE_TARGETS_TYPE).push([{ root: "other" }]),
    ],
  ])("rejects hostile reserved namespace %s before journaling", async (_name, mutate) => {
    const liveDocument = documentWithReservedFacts();
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(async () => ({ seq: 1, joinedSettlement: false }));
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => ({ documents: new Map([[DOCUMENT_ID, liveDocument]]) }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });
    const client = cloneDoc(liveDocument);
    const vector = Y.encodeStateVector(client);
    mutate(client);

    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document: liveDocument,
        update: Y.encodeStateAsUpdate(client, vector),
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 1n,
      }),
    ).rejects.toThrow();
    expect(journal.appendWriterUpdate).not.toHaveBeenCalled();
  });

  it("rejects a caller-supplied document that is not the bound room liveDocument", async () => {
    const liveDocument = documentWithReservedFacts();
    const wrongDocument = boundDoc({ gc: false });
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(async () => ({ seq: 1, joinedSettlement: false }));
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => ({ documents: new Map([[DOCUMENT_ID, liveDocument]]) }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });

    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document: wrongDocument,
        update: writerUpdate(),
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 1n,
      }),
    ).rejects.toThrow("live-document-room-mismatch");
    expect(journal.appendWriterUpdate).not.toHaveBeenCalled();
  });

  it("rejects reserved-client-ID injection before journaling", async () => {
    const liveDocument = boundDoc({ gc: false });
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(async () => ({ seq: 1, joinedSettlement: false }));
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () => ({ documents: new Map([[DOCUMENT_ID, liveDocument]]) }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });
    const client = boundDoc();
    client.clientID = 999;
    client.getText("content").insert(0, "hostile");
    await expect(
      persistence.admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document: liveDocument,
        update: Y.encodeStateAsUpdate(client),
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 1n,
      }),
    ).rejects.toThrow("reserved-writer-client-id");
    expect(journal.appendWriterUpdate).not.toHaveBeenCalled();
  });

  it("does not resolve admission until the journal transaction commits", async () => {
    const liveDocument = boundDoc({ gc: false });
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
      hocuspocus: () => ({ documents: new Map([[DOCUMENT_ID, liveDocument]]) }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });
    const update = writerUpdate();
    const admission = persistence
      .admitLiveWriterUpdate({
        documentId: DOCUMENT_ID,
        document: liveDocument,
        update,
        origin: { type: "user", userId: "user-1" },
        expectedGeneration: 1n,
      })
      .then((result) => {
        events.push("apply/broadcast/ack");
        return result;
      });

    await Promise.resolve();
    expect(events).toEqual(["journal:start"]);
    commit?.();
    await expect(admission).resolves.toEqual({ admitted: true, joinedSettlement: true });
    expect(events).toEqual(["journal:start", "journal:commit", "apply/broadcast/ack"]);
  });

  it("rejects journal failure before the transport can apply or acknowledge", async () => {
    const liveDocument = boundDoc({ gc: false });
    const events = new RecentEventsBuffer();
    const journal = fakeJournal();
    journal.appendWriterUpdate = vi.fn(async () => {
      throw new Error("database unavailable");
    });
    const persistence = createHocuspocusPersistenceService({
      journal,
      hocuspocus: () =>
        ({
          documents: new Map([[DOCUMENT_ID, liveDocument]]),
          getDocumentsCount: () => 1,
          getConnectionsCount: () => 0,
        }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      eventSink: events,
      emitAgentEditInvariantViolation: () => undefined,
    });
    let appliedOrAcknowledged = false;

    await expect(
      persistence
        .admitLiveWriterUpdate({
          documentId: DOCUMENT_ID,
          document: liveDocument,
          update: writerUpdate(),
          origin: { type: "user", userId: "user-1" },
          expectedGeneration: 1n,
        })
        .then(() => {
          appliedOrAcknowledged = true;
        }),
    ).rejects.toThrow("database unavailable");
    expect(appliedOrAcknowledged).toBe(false);
    expect(persistence.getPersistenceQueueMetrics().queues).toEqual([
      expect.objectContaining({ documentId: DOCUMENT_ID, dropped: 1 }),
    ]);
    expect(events.query({ correlation: { documentId: DOCUMENT_ID } }).events).toEqual([
      expect.objectContaining({ name: "persistence_append.failed" }),
    ]);
  });

  it("drains started admissions and detects a later generation", async () => {
    const liveDocument = boundDoc({ gc: false });
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
      hocuspocus: () => ({ documents: new Map([[DOCUMENT_ID, liveDocument]]) }) as never,
      metaForOrigin: () => ({ origin: "human:user-1", seq: 0 }),
      latestUpdateSeq: async () => 0,
      emitAgentEditInvariantViolation: () => undefined,
    });
    const first = persistence.admitLiveWriterUpdate({
      documentId: DOCUMENT_ID,
      document: liveDocument,
      update: writerUpdate(),
      origin: { type: "user", userId: "user-1" },
      expectedGeneration: 1n,
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
      document: liveDocument,
      update: writerUpdate(),
      origin: { type: "user", userId: "user-1" },
      expectedGeneration: 1n,
    });
    expect(persistence.writerIngressBarrier.isGenerationCurrent(DOCUMENT_ID, generation)).toBe(
      false,
    );
    resolvers[1]?.();
    await second;
  });
});

function writerUpdate(): Uint8Array {
  const doc = boundDoc();
  doc.getText("content").insert(0, "writer");
  return Y.encodeStateAsUpdate(doc);
}

function documentWithReservedFacts(): Y.Doc {
  const doc = boundDoc({ gc: false });
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

function docWithText(text: string, generation = 1n): Y.Doc {
  const doc = boundDoc({ gc: false }, generation);
  doc.getText("content").insert(0, text);
  return doc;
}

function cloneDoc(doc: Y.Doc, generation = 1n): Y.Doc {
  const clone = boundDoc({ gc: false }, generation);
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
    schemaVersion: COLLAB_SCHEMA_VERSION,
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

function boundDoc(options?: ConstructorParameters<typeof Y.Doc>[0], generation = 1n): Y.Doc {
  const doc = new Y.Doc(options);
  bindDocumentAuthority(doc, { authorityId: "test-authority" as never, generation });
  return doc;
}
