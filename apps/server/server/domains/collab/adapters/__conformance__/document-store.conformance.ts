/**
 * Shared conformance suite for the DocumentStore port: every adapter (drizzle,
 * in-memory) runs this same behavioral spec so they stay interchangeable. Owns
 * the cross-adapter fixtures and the describe* harness; imported by each
 * adapter's own test file.
 */
import { describe, expect, it } from "vitest";
import type { DocumentStore } from "../../ports/document-store.js";

const DOC_A = "00000000-0000-4000-a000-000000000001";
const DOC_B = "00000000-0000-4000-a000-000000000002";
const DOC_C = "00000000-0000-4000-a000-000000000003";
const USER_ID = "00000000-0000-4000-a000-000000000301";
const AGENT_RUN_ID = "00000000-0000-4000-a000-000000000101";
const TURN_ID = "00000000-0000-4000-a000-000000000201";
const CONTEXT_SOURCE_ID = "00000000-0000-4000-b000-000000000001";

export const documentStoreConformanceFixtures = {
  userId: USER_ID,
  contextSourceId: CONTEXT_SOURCE_ID,
  documentIds: [DOC_A, DOC_B, DOC_C] as const,
};

export function describeDocumentStoreConformance(
  name: string,
  makeStore: () => DocumentStore | Promise<DocumentStore>,
): void {
  describe(`DocumentStore conformance: ${name}`, () => {
    it("starts empty and upserts document heads", async () => {
      const store = await makeStore();

      expect(await store.getHead(DOC_A)).toBeNull();

      await store.upsertHead({
        documentId: DOC_A,
        fragmentName: "prosemirror",
        schemaVersion: 1,
        filetype: "markdown",
        latestUpdateSeq: 0,
        latestStateVector: null,
        latestCheckpointId: null,
      });
      expect(await store.getHead(DOC_A)).toMatchObject({
        documentId: DOC_A,
        fragmentName: "prosemirror",
        schemaVersion: 1,
        filetype: "markdown",
        latestUpdateSeq: 0,
        latestStateVector: null,
        latestCheckpointId: null,
      });

      const checkpointId = await store.insertCheckpoint({
        documentId: DOC_A,
        state: bytes(7, 8, 9),
        stateVector: bytes(10, 11, 12),
        upToSeq: 2,
        reason: "head checkpoint",
      });

      await store.upsertHead({
        documentId: DOC_A,
        fragmentName: "body",
        schemaVersion: 1,
        filetype: "python",
        latestUpdateSeq: 2,
        latestStateVector: bytes(1, 2, 3),
        latestCheckpointId: checkpointId,
      });

      const head = await store.getHead(DOC_A);
      expect(head).toMatchObject({
        documentId: DOC_A,
        fragmentName: "body",
        filetype: "python",
        latestUpdateSeq: 2,
        latestCheckpointId: checkpointId,
      });
      expectBytes(head?.latestStateVector, [1, 2, 3]);
    });

    it("appends updates with monotonic sequence ids and document-scoped reads", async () => {
      const store = await makeStore();

      const first = await store.appendUpdate({
        documentId: DOC_A,
        updateData: bytes(1, 2),
        originType: "user",
        actorUserId: USER_ID,
        actorAgentRunId: null,
        actorTurnId: null,
      });
      const second = await store.appendUpdate({
        documentId: DOC_A,
        updateData: bytes(3, 4),
        originType: "agent",
        actorUserId: null,
        actorAgentRunId: AGENT_RUN_ID,
        actorTurnId: TURN_ID,
      });
      const otherDocument = await store.appendUpdate({
        documentId: DOC_B,
        updateData: bytes(5, 6),
        originType: null,
        actorUserId: null,
        actorAgentRunId: null,
        actorTurnId: null,
      });

      expect(first < second).toBe(true);
      expect(second < otherDocument).toBe(true);
      await expect(store.countUpdatesAfter(DOC_A, 0)).resolves.toBe(2);
      await expect(store.countUpdatesAfter(DOC_A, first)).resolves.toBe(1);
      await expect(store.countUpdatesAfter(DOC_A, second)).resolves.toBe(0);

      const afterFirst = await store.listUpdatesAfter(DOC_A, first);
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0]).toMatchObject({
        seq: second,
        documentId: DOC_A,
        originType: "agent",
        actorUserId: null,
        actorAgentRunId: AGENT_RUN_ID,
        actorTurnId: TURN_ID,
      });
      expect(afterFirst[0].createdAt).toEqual(expect.any(String));
      expectBytes(afterFirst[0].updateData, [3, 4]);

      const docBUpdates = await store.listUpdatesAfter(DOC_B, 0);
      expect(docBUpdates.map((update) => update.seq)).toEqual([otherDocument]);
      expectBytes(docBUpdates[0]?.updateData, [5, 6]);
    });

    it("stores checkpoints newest-first and restore points by document", async () => {
      const store = await makeStore();

      const firstUpdateSeq = await store.appendUpdate({
        documentId: DOC_A,
        updateData: bytes(1),
        originType: "system",
        actorUserId: null,
        actorAgentRunId: null,
        actorTurnId: null,
      });
      const secondUpdateSeq = await store.appendUpdate({
        documentId: DOC_A,
        updateData: bytes(2),
        originType: "system",
        actorUserId: null,
        actorAgentRunId: null,
        actorTurnId: null,
      });

      const firstCheckpoint = await store.insertCheckpoint({
        documentId: DOC_A,
        state: bytes(10, 11),
        stateVector: bytes(12, 13),
        upToSeq: firstUpdateSeq,
        reason: null,
      });
      const secondCheckpoint = await store.insertCheckpoint({
        documentId: DOC_A,
        state: bytes(20, 21),
        stateVector: bytes(22, 23),
        upToSeq: secondUpdateSeq,
        reason: "manual",
      });
      const otherCheckpoint = await store.insertCheckpoint({
        documentId: DOC_B,
        state: bytes(30),
        stateVector: bytes(31),
        upToSeq: 1,
        reason: "other document",
      });

      const latest = await store.getLatestCheckpoint(DOC_A);
      expect(latest).toMatchObject({
        id: secondCheckpoint,
        documentId: DOC_A,
        upToSeq: secondUpdateSeq,
        reason: "manual",
      });
      expectBytes(latest?.state, [20, 21]);
      expectBytes(latest?.stateVector, [22, 23]);

      const loadedFirst = await store.getCheckpoint(firstCheckpoint);
      expect(loadedFirst).toMatchObject({ id: firstCheckpoint, reason: null });
      expectBytes(loadedFirst?.state, [10, 11]);
      await expect(store.getCheckpoint(999999)).resolves.toBeNull();
      expect((await store.listCheckpoints(DOC_A)).map((checkpoint) => checkpoint.id)).toEqual([
        secondCheckpoint,
        firstCheckpoint,
      ]);
      expect((await store.listCheckpoints(DOC_B)).map((checkpoint) => checkpoint.id)).toEqual([
        otherCheckpoint,
      ]);

      const restorePoint = await store.insertRestorePoint({
        documentId: DOC_A,
        name: "Before agent edit",
        checkpointId: secondCheckpoint,
        upToSeq: secondUpdateSeq,
        createdByUserId: USER_ID,
      });
      const floatingRestorePoint = await store.insertRestorePoint({
        documentId: DOC_A,
        name: "Floating restore point",
        checkpointId: null,
        upToSeq: null,
        createdByUserId: null,
      });
      await store.insertRestorePoint({
        documentId: DOC_B,
        name: "Other document restore point",
        checkpointId: otherCheckpoint,
        upToSeq: 1,
        createdByUserId: null,
      });

      expect(restorePoint.id).toEqual(expect.any(String));
      expect(restorePoint.createdAt).toEqual(expect.any(String));
      expect(await store.getRestorePoint(restorePoint.id)).toMatchObject({
        id: restorePoint.id,
        documentId: DOC_A,
        name: "Before agent edit",
        checkpointId: secondCheckpoint,
        upToSeq: secondUpdateSeq,
        createdByUserId: USER_ID,
      });
      await expect(
        store.getRestorePoint("00000000-0000-4000-a000-999999999999"),
      ).resolves.toBeNull();
      expect(new Set((await store.listRestorePoints(DOC_A)).map((point) => point.id))).toEqual(
        new Set([restorePoint.id, floatingRestorePoint.id]),
      );
    });

    it("commits transaction writes and rolls back failed callbacks", async () => {
      const store = await makeStore();

      await store.transaction(async (tx) => {
        const updateSeq = await tx.appendUpdate({
          documentId: DOC_A,
          updateData: bytes(1, 2, 3),
          originType: "system",
          actorUserId: null,
          actorAgentRunId: null,
          actorTurnId: null,
        });
        const checkpointId = await tx.insertCheckpoint({
          documentId: DOC_A,
          state: bytes(4, 5, 6),
          stateVector: bytes(7, 8, 9),
          upToSeq: updateSeq,
          reason: "commit",
        });
        await tx.upsertHead({
          documentId: DOC_A,
          fragmentName: "prosemirror",
          schemaVersion: 1,
          filetype: "markdown",
          latestUpdateSeq: updateSeq,
          latestStateVector: bytes(10, 11, 12),
          latestCheckpointId: checkpointId,
        });
        await tx.insertRestorePoint({
          documentId: DOC_A,
          name: "committed",
          checkpointId,
          upToSeq: updateSeq,
          createdByUserId: null,
        });

        expect(await tx.countUpdatesAfter(DOC_A, 0)).toBe(1);
      });

      const beforeRollback = await snapshotDocument(store, DOC_A);

      await expect(
        store.transaction(async (tx) => {
          const updateSeq = await tx.appendUpdate({
            documentId: DOC_B,
            updateData: bytes(99),
            originType: "system",
            actorUserId: null,
            actorAgentRunId: null,
            actorTurnId: null,
          });
          const checkpointId = await tx.insertCheckpoint({
            documentId: DOC_B,
            state: bytes(98),
            stateVector: bytes(97),
            upToSeq: updateSeq,
            reason: "rollback",
          });
          await tx.upsertHead({
            documentId: DOC_B,
            fragmentName: "prosemirror",
            schemaVersion: 1,
            filetype: "markdown",
            latestUpdateSeq: updateSeq,
            latestStateVector: bytes(96),
            latestCheckpointId: checkpointId,
          });

          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");

      expect(await snapshotDocument(store, DOC_A)).toEqual(beforeRollback);
      await expect(store.getHead(DOC_B)).resolves.toBeNull();
      await expect(store.listUpdatesAfter(DOC_B, 0)).resolves.toEqual([]);
      await expect(store.listCheckpoints(DOC_B)).resolves.toEqual([]);
    });

    it("isolates caller mutations to byte buffers read from and written inside transactions", async () => {
      const store = await makeStore();
      await store.upsertHead({
        documentId: DOC_A,
        fragmentName: "prosemirror",
        schemaVersion: 1,
        filetype: "markdown",
        latestUpdateSeq: 1,
        latestStateVector: bytes(1, 2, 3),
        latestCheckpointId: null,
      });
      await store.appendUpdate({
        documentId: DOC_A,
        updateData: bytes(4, 5, 6),
        originType: "system",
        actorUserId: null,
        actorAgentRunId: null,
        actorTurnId: null,
      });
      const checkpointId = await store.insertCheckpoint({
        documentId: DOC_A,
        state: bytes(7, 8, 9),
        stateVector: bytes(10, 11, 12),
        upToSeq: 1,
        reason: "before mutation",
      });

      let writtenCheckpointId = 0;

      await store.transaction(async (tx) => {
        const head = await tx.getHead(DOC_A);
        const [update] = await tx.listUpdatesAfter(DOC_A, 0);
        const checkpoint = await tx.getCheckpoint(checkpointId);

        if (!head?.latestStateVector || !update || !checkpoint) {
          throw new Error("expected seeded rows");
        }

        head.latestStateVector[0] = 99;
        update.updateData[0] = 99;
        checkpoint.state[0] = 99;
        checkpoint.stateVector[0] = 99;

        const writtenStateVector = bytes(13, 14, 15);
        const writtenUpdateData = bytes(16, 17, 18);
        const writtenCheckpointState = bytes(19, 20, 21);
        const writtenCheckpointStateVector = bytes(22, 23, 24);

        await tx.upsertHead({
          documentId: DOC_B,
          fragmentName: "prosemirror",
          schemaVersion: 1,
          filetype: "markdown",
          latestUpdateSeq: 1,
          latestStateVector: writtenStateVector,
          latestCheckpointId: null,
        });
        await tx.appendUpdate({
          documentId: DOC_B,
          updateData: writtenUpdateData,
          originType: "system",
          actorUserId: null,
          actorAgentRunId: null,
          actorTurnId: null,
        });
        writtenCheckpointId = await tx.insertCheckpoint({
          documentId: DOC_B,
          state: writtenCheckpointState,
          stateVector: writtenCheckpointStateVector,
          upToSeq: 1,
          reason: "written inside transaction",
        });

        writtenStateVector[0] = 99;
        writtenUpdateData[0] = 99;
        writtenCheckpointState[0] = 99;
        writtenCheckpointStateVector[0] = 99;
      });

      expectBytes((await store.getHead(DOC_A))?.latestStateVector, [1, 2, 3]);
      const [committedUpdate] = await store.listUpdatesAfter(DOC_A, 0);
      expectBytes(committedUpdate?.updateData, [4, 5, 6]);
      const committedCheckpoint = await store.getCheckpoint(checkpointId);
      expectBytes(committedCheckpoint?.state, [7, 8, 9]);
      expectBytes(committedCheckpoint?.stateVector, [10, 11, 12]);

      expectBytes((await store.getHead(DOC_B))?.latestStateVector, [13, 14, 15]);
      const [writtenUpdate] = await store.listUpdatesAfter(DOC_B, 0);
      expectBytes(writtenUpdate?.updateData, [16, 17, 18]);
      const writtenCheckpoint = await store.getCheckpoint(writtenCheckpointId);
      expectBytes(writtenCheckpoint?.state, [19, 20, 21]);
      expectBytes(writtenCheckpoint?.stateVector, [22, 23, 24]);
    });

    it("compacts only the requested document log while preserving requested checkpoints", async () => {
      const store = await makeStore();

      const first = await appendSystemUpdate(store, DOC_A, bytes(1));
      const second = await appendSystemUpdate(store, DOC_A, bytes(2));
      const third = await appendSystemUpdate(store, DOC_A, bytes(3));
      const otherDocumentUpdate = await appendSystemUpdate(store, DOC_B, bytes(4));

      const oldCheckpoint = await store.insertCheckpoint({
        documentId: DOC_A,
        state: bytes(10),
        stateVector: bytes(11),
        upToSeq: first,
        reason: "old",
      });
      const keptCheckpoint = await store.insertCheckpoint({
        documentId: DOC_A,
        state: bytes(20),
        stateVector: bytes(21),
        upToSeq: second,
        reason: "keep",
      });
      const latestCheckpoint = await store.insertCheckpoint({
        documentId: DOC_A,
        state: bytes(30),
        stateVector: bytes(31),
        upToSeq: third,
        reason: "latest",
      });
      const otherDocumentCheckpoint = await store.insertCheckpoint({
        documentId: DOC_B,
        state: bytes(40),
        stateVector: bytes(41),
        upToSeq: otherDocumentUpdate,
        reason: "other document",
      });

      await store.compactDocumentLog({
        documentId: DOC_A,
        pruneUpdatesThroughSeq: second,
        pruneRowsCreatedBefore: new Date(Date.now() + 60_000).toISOString(),
        keepCheckpointIds: [keptCheckpoint],
        pruneCheckpointsThroughSeq: second,
      });

      expect((await store.listUpdatesAfter(DOC_A, 0)).map((update) => update.seq)).toEqual([third]);
      expect((await store.listUpdatesAfter(DOC_B, 0)).map((update) => update.seq)).toEqual([
        otherDocumentUpdate,
      ]);
      await expect(store.getCheckpoint(oldCheckpoint)).resolves.toBeNull();
      expect((await store.listCheckpoints(DOC_A)).map((checkpoint) => checkpoint.id)).toEqual([
        latestCheckpoint,
        keptCheckpoint,
      ]);
      expect((await store.listCheckpoints(DOC_B)).map((checkpoint) => checkpoint.id)).toEqual([
        otherDocumentCheckpoint,
      ]);
    });
  });
}

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function expectBytes(actual: Uint8Array | null | undefined, expected: number[]) {
  expect(actual ? [...actual] : actual).toEqual(expected);
}

async function appendSystemUpdate(
  store: DocumentStore,
  documentId: string,
  updateData: Uint8Array,
): Promise<number> {
  return store.appendUpdate({
    documentId,
    updateData,
    originType: "system",
    actorUserId: null,
    actorAgentRunId: null,
    actorTurnId: null,
  });
}

async function snapshotDocument(store: DocumentStore, documentId: string) {
  const head = await store.getHead(documentId);
  const updates = await store.listUpdatesAfter(documentId, 0);
  const checkpoints = await store.listCheckpoints(documentId);
  const restorePoints = await store.listRestorePoints(documentId);

  return {
    head: head
      ? {
          ...head,
          latestStateVector: head.latestStateVector ? [...head.latestStateVector] : null,
        }
      : null,
    updates: updates.map((update) => ({
      ...update,
      updateData: [...update.updateData],
      createdAt: expect.any(String),
    })),
    checkpoints: checkpoints.map((checkpoint) => ({
      ...checkpoint,
      state: [...checkpoint.state],
      stateVector: [...checkpoint.stateVector],
      createdAt: expect.any(String),
    })),
    restorePoints: restorePoints.map((restorePoint) => ({
      ...restorePoint,
      createdAt: expect.any(String),
    })),
  };
}
