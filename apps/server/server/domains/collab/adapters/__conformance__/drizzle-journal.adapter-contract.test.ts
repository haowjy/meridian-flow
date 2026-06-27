/** Adapter-contract tests for the Drizzle UpdateJournal & ReversalStore against local Postgres. */
import { COLLAB_SCHEMA_VERSION, RESERVED_CLIENT_ID_MAX } from "@meridian/prosemirror-schema";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;

const USER_ID = "00000000-0000-4000-8000-000000000201";
const PROJECT_ID = "00000000-0000-4000-8000-000000000202";
const CONTEXT_SOURCE_ID = "00000000-0000-4000-8000-000000000203";
const DOC_ID = "00000000-0000-4000-8000-000000000204";
const MISSING_DOC_ID = "00000000-0000-4000-8000-0000000002fe";
const THREAD_ID = "00000000-0000-4000-8000-000000000205";
const TURN_A = "00000000-0000-4000-8000-000000000206";
const TURN_B = "00000000-0000-4000-8000-000000000207";
const TURN_C = "00000000-0000-4000-8000-000000000208";
const TURN_D = "00000000-0000-4000-8000-000000000209";
const TURN_E = "00000000-0000-4000-8000-00000000020a";
const CONCURRENT_TURNS = [
  "00000000-0000-4000-8000-00000000020b",
  "00000000-0000-4000-8000-00000000020c",
  "00000000-0000-4000-8000-00000000020d",
  "00000000-0000-4000-8000-00000000020e",
  "00000000-0000-4000-8000-00000000020f",
  "00000000-0000-4000-8000-000000000210",
  "00000000-0000-4000-8000-000000000211",
  "00000000-0000-4000-8000-000000000212",
] as const;
const MISSING_THREAD_ID = "00000000-0000-4000-8000-0000000002ff";
const STALE_SCHEMA_DOC_ID = "00000000-0000-4000-8000-000000000213";
const LIVE_CLIENT_ID = RESERVED_CLIENT_ID_MAX + 1;

if (!RUN_DB_TESTS || !DATABASE_URL) {
  describe.skip("drizzle journal (postgres)", () => {
    it("requires RUN_DB_TESTS and DATABASE_URL", () => {});
  });
} else {
  describe("drizzle journal adapter contract (postgres)", async () => {
    const { createDb } = await import("@meridian/database");
    const dbSchema = await import("@meridian/database/schema");
    const {
      contextSources,
      agentEditMutations,
      agentEditWidCounters,
      documentYjsCheckpoints,
      documentYjsHeads,
      documentYjsReversals,
      documentYjsUpdates,
      documents,
      folders,
      projects,
      threads,
      turns,
      users,
    } = dbSchema;
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { asc, eq } = await import("drizzle-orm");
    const { truncateDrizzleTables } = await import("../../../../test-support/drizzle-reset.js");
    const { createDrizzleJournal } = await import("../drizzle-journal.js");
    const { StaleDocumentSchemaError } = await import("../../domain/stale-schema.js");
    const { expectReversalMutationStatusContract } = await import(
      "./journal-reversal-mutation-status-contract.js"
    );

    const db = createDb(DATABASE_URL, { max: 4 });

    async function truncateAll(): Promise<void> {
      await truncateDrizzleTables(db, [
        agentEditMutations,
        agentEditWidCounters,
        documentYjsReversals,
        documentYjsHeads,
        documentYjsUpdates,
        documentYjsCheckpoints,
        turns,
        threads,
        documents,
        folders,
        contextSources,
        projects,
        users,
      ]);
    }

    async function ensureFixtures(): Promise<void> {
      await db.insert(users).values(conformanceUserValues(USER_ID, "drizzle-journal"));
      await db.insert(projects).values({
        id: PROJECT_ID,
        userId: USER_ID,
        name: "Journal Project",
        slug: "journal-project",
      });
      await db.insert(contextSources).values({
        id: CONTEXT_SOURCE_ID,
        projectId: PROJECT_ID,
        name: "Journal Source",
        slug: "journal-source",
        scope: "project",
      });
      await db.insert(documents).values({
        id: DOC_ID,
        contextSourceId: CONTEXT_SOURCE_ID,
        name: "chapter",
        extension: "md",
        fileType: "markdown",
      });
      await db.insert(threads).values({
        id: THREAD_ID,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        title: "Journal Thread",
        kind: "primary",
        status: "active",
      });
      await db.insert(turns).values([
        { id: TURN_A, threadId: THREAD_ID, role: "assistant", status: "complete" },
        {
          id: TURN_B,
          threadId: THREAD_ID,
          parentTurnId: TURN_A,
          role: "assistant",
          status: "complete",
        },
        {
          id: TURN_C,
          threadId: THREAD_ID,
          parentTurnId: TURN_B,
          role: "assistant",
          status: "complete",
        },
        {
          id: TURN_D,
          threadId: THREAD_ID,
          parentTurnId: TURN_C,
          role: "assistant",
          status: "complete",
        },
        {
          id: TURN_E,
          threadId: THREAD_ID,
          parentTurnId: TURN_D,
          role: "assistant",
          status: "complete",
        },
        ...CONCURRENT_TURNS.map((id) => ({
          id,
          threadId: THREAD_ID,
          parentTurnId: TURN_E,
          role: "assistant" as const,
          status: "complete" as const,
        })),
      ]);
    }

    async function updateIds(): Promise<number[]> {
      const rows = await db
        .select({ id: documentYjsUpdates.id })
        .from(documentYjsUpdates)
        .where(eq(documentYjsUpdates.documentId, DOC_ID))
        .orderBy(asc(documentYjsUpdates.id));
      return rows.map((row) => row.id);
    }

    async function mutationRows() {
      return db
        .select({
          wId: agentEditMutations.wId,
          documentId: agentEditMutations.documentId,
          threadId: agentEditMutations.threadId,
          turnId: agentEditMutations.turnId,
          status: agentEditMutations.status,
          createdSeq: agentEditMutations.createdSeq,
          undoUpdateSeq: agentEditMutations.undoUpdateSeq,
          reversedBy: agentEditMutations.reversedBy,
        })
        .from(agentEditMutations)
        .where(eq(agentEditMutations.documentId, DOC_ID))
        .orderBy(asc(agentEditMutations.wId));
    }

    beforeEach(async () => {
      await truncateAll();
      await ensureFixtures();
    });

    afterAll(async () => {
      await db.close();
    });

    it("matches reversal mutation status transitions", async () => {
      await expectReversalMutationStatusContract({
        journal: createDrizzleJournal(db),
        docId: DOC_ID,
        threadId: THREAD_ID,
        turnIds: [TURN_A, TURN_B],
        userId: USER_ID,
      });
    });

    it("matches append/read/checkpoint/compact/reversal contract behavior", async () => {
      const journal = createDrizzleJournal(db);
      const doc = new Y.Doc({ gc: false });
      doc.clientID = LIVE_CLIENT_ID;

      const updateA = appendText(doc, "Alpha");
      const seqA = await journal.append(DOC_ID, updateA, {
        origin: `agent:${TURN_A}`,
        actorTurnId: TURN_A,
        seq: 0,
      });
      const updateB = appendText(doc, " Beta");
      const seqB = await journal.append(DOC_ID, updateB, {
        origin: `human:${USER_ID}`,
        actorTurnId: TURN_B,
        seq: 0,
      });
      const updateC = appendText(doc, " Gamma");
      const seqC = await journal.append(DOC_ID, updateC, { origin: "system", seq: 0 });

      expect(seqA).toBeLessThan(seqB);
      expect(seqB).toBeLessThan(seqC);

      const bounded = await journal.read(DOC_ID, { since: seqB, until: seqC });
      expect(bounded.updates.map((update) => update.seq)).toEqual([seqB, seqC]);

      const initial = await journal.read(DOC_ID);
      expect(initial.checkpoint).toBeNull();
      expect(initial.updates.map((update) => update.seq)).toEqual([seqA, seqB, seqC]);
      expect(initial.updates[0]?.meta).toEqual({
        origin: `agent:${TURN_A}`,
        actorTurnId: TURN_A,
        seq: seqA,
      });
      expect(initial.updates[1]?.meta).toEqual({
        origin: `human:${USER_ID}`,
        actorTurnId: TURN_B,
        seq: seqB,
      });
      expect(initial.updates[2]?.meta).toEqual({ origin: "system", seq: seqC });

      await journal.checkpoint(DOC_ID, Y.encodeStateAsUpdate(doc), seqC);
      const afterCheckpoint = await journal.read(DOC_ID);
      expect(afterCheckpoint.checkpoint).toBeInstanceOf(Uint8Array);
      expect(afterCheckpoint.updates).toEqual([]);
      const fullLogAfterCheckpoint = await journal.readForReconstruction(DOC_ID);
      expect(fullLogAfterCheckpoint.checkpoint).toBeNull();
      expect(fullLogAfterCheckpoint.updates.map((update) => update.seq)).toEqual([
        seqA,
        seqB,
        seqC,
      ]);

      const updateD = appendText(doc, " Delta");
      const seqD = await journal.append(DOC_ID, updateD, {
        origin: `agent:${TURN_C}`,
        actorTurnId: TURN_C,
        seq: 0,
      });
      const updateE = appendText(doc, " Epsilon");
      const seqE = await journal.append(DOC_ID, updateE, {
        origin: `agent:${TURN_D}`,
        actorTurnId: TURN_D,
        seq: 0,
      });
      expect((await journal.read(DOC_ID)).updates.map((update) => update.seq)).toEqual([
        seqD,
        seqE,
      ]);

      await db.insert(documentYjsReversals).values({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        turnId: TURN_D,
        writeId: "w-expired",
        status: "active",
        undoUpdateSeq: seqE,
        expiresAt: new Date("2000-01-01T00:00:00.000Z"),
      });

      const compacted = await journal.compact(DOC_ID, new Date("2100-01-01T00:00:00.000Z"));
      expect(compacted).toEqual({ updatesFolded: 2, reversalsExpired: 1 });
      const afterCompact = await journal.read(DOC_ID);
      expect(afterCompact.checkpoint).toBeInstanceOf(Uint8Array);
      expect(afterCompact.updates).toEqual([]);
      expect(textFromSnapshot(afterCompact.checkpoint, afterCompact.updates)).toBe(
        doc.getText("body").toString(),
      );
      const [expired] = await db
        .select({ status: documentYjsReversals.status })
        .from(documentYjsReversals)
        .where(eq(documentYjsReversals.turnId, TURN_D));
      expect(expired?.status).toBe("expired");

      const undoUpdate = appendText(doc, " Undo");
      const record = {
        documentId: DOC_ID,
        threadId: THREAD_ID,
        turnId: TURN_E,
        writeIds: ["w1"],
        status: "reversed" as const,
        undoUpdateSeq: 0,
        reversedAt: new Date("2026-06-21T00:00:00.000Z"),
        reversedByUserId: USER_ID,
      };
      await journal.persistUndo(DOC_ID, undoUpdate, [record]);
      expect(record.undoUpdateSeq).toBeGreaterThan(seqE);

      const withUndo = await journal.read(DOC_ID);
      const persistedUndo = withUndo.updates.find((update) => update.seq === record.undoUpdateSeq);
      expect(persistedUndo).toBeDefined();
      expect(Array.from(persistedUndo?.update ?? [])).toEqual(Array.from(undoUpdate));
      expect(persistedUndo?.meta).toEqual({ origin: "system", seq: record.undoUpdateSeq });

      const [reversal] = await db
        .select()
        .from(documentYjsReversals)
        .where(eq(documentYjsReversals.turnId, TURN_E));
      expect(reversal).toMatchObject({
        documentId: DOC_ID,
        threadId: THREAD_ID,
        turnId: TURN_E,
        status: "reversed",
        undoUpdateSeq: record.undoUpdateSeq,
        reversedByUserId: USER_ID,
      });

      const idsBeforeFailure = await updateIds();
      await expect(
        journal.persistUndo(DOC_ID, appendText(doc, " Rolled back"), [
          {
            documentId: DOC_ID,
            threadId: MISSING_THREAD_ID,
            turnId: TURN_E,
            writeIds: ["w1"],
            status: "reversed",
            undoUpdateSeq: 0,
          },
        ]),
      ).rejects.toThrow();
      expect(await updateIds()).toEqual(idsBeforeFailure);
      expect((await journal.read(DOC_ID)).updates.map((update) => update.seq)).toEqual([
        record.undoUpdateSeq,
      ]);

      const redoUpdate = appendText(doc, " Redo");
      const redo = await journal.persistRedo(
        DOC_ID,
        redoUpdate,
        { threadId: THREAD_ID, undoUpdateSeq: record.undoUpdateSeq },
        { origin: "system", seq: 0 },
      );
      expect(redo.consumed).toBe(true);
      expect(redo.seq).toBeGreaterThan(record.undoUpdateSeq);
      expect(
        await journal.readReversals(DOC_ID, { threadId: THREAD_ID, status: ["redone"] }),
      ).toMatchObject([{ turnId: TURN_E, status: "redone" }]);

      const idsAfterRedo = await updateIds();
      await expect(
        journal.persistRedo(
          DOC_ID,
          redoUpdate,
          { threadId: THREAD_ID, undoUpdateSeq: record.undoUpdateSeq },
          { origin: "system", seq: 0 },
        ),
      ).resolves.toEqual({ consumed: false });
      await expect(
        journal.persistRedo(
          DOC_ID,
          redoUpdate,
          { threadId: MISSING_THREAD_ID, undoUpdateSeq: record.undoUpdateSeq },
          { origin: "system", seq: 0 },
        ),
      ).resolves.toEqual({ consumed: false });
      expect(await updateIds()).toEqual(idsAfterRedo);
    });

    it("appends journal batches in one transaction", async () => {
      const journal = createDrizzleJournal(db);
      const doc = new Y.Doc({ gc: false });
      doc.clientID = LIVE_CLIENT_ID;
      const updateA = appendText(doc, "Alpha");
      const updateB = appendText(doc, " Beta");

      const results = await journal.appendBatch([
        {
          docId: DOC_ID,
          update: updateA,
          meta: { origin: `agent:${TURN_A}`, actorTurnId: TURN_A, seq: 0 },
        },
        {
          docId: DOC_ID,
          update: updateB,
          meta: { origin: `agent:${TURN_B}`, actorTurnId: TURN_B, seq: 0 },
        },
      ]);
      const seqs = results.map((result) => result.seq);

      expect(results).toHaveLength(2);
      expect(results.every((result) => result.wId === undefined)).toBe(true);
      expect((await journal.read(DOC_ID)).updates.map((update) => update.seq)).toEqual(seqs);
      const idsBeforeFailure = await updateIds();
      const updateC = appendText(doc, " Gamma");
      const updateD = appendText(doc, " Delta");

      await expect(
        journal.appendBatch([
          {
            docId: DOC_ID,
            update: updateC,
            meta: { origin: `agent:${TURN_C}`, actorTurnId: TURN_C, seq: 0 },
          },
          {
            docId: MISSING_DOC_ID,
            update: updateD,
            meta: { origin: `agent:${TURN_D}`, actorTurnId: TURN_D, seq: 0 },
          },
        ]),
      ).rejects.toThrow();
      expect(await updateIds()).toEqual(idsBeforeFailure);
    });

    it("mints mutation w-ids atomically with journal batches", async () => {
      const journal = createDrizzleJournal(db);
      const doc = new Y.Doc({ gc: false });
      doc.clientID = LIVE_CLIENT_ID;

      const first = await journal.appendBatch([
        {
          docId: DOC_ID,
          update: appendText(doc, "Alpha"),
          meta: { origin: `agent:${TURN_A}`, actorTurnId: TURN_A, seq: 0 },
          mutation: { threadId: THREAD_ID, turnId: TURN_A },
        },
        {
          docId: DOC_ID,
          update: appendText(doc, " Beta"),
          meta: { origin: `agent:${TURN_B}`, actorTurnId: TURN_B, seq: 0 },
          mutation: { threadId: THREAD_ID, turnId: TURN_B },
        },
      ]);
      expect(first.map((result) => result.wId)).toEqual([1, 2]);

      const second = await journal.appendBatch([
        {
          docId: DOC_ID,
          update: appendText(doc, " Gamma"),
          meta: { origin: `agent:${TURN_C}`, actorTurnId: TURN_C, seq: 0 },
          mutation: { threadId: THREAD_ID, turnId: TURN_C },
        },
      ]);
      expect(second.map((result) => result.wId)).toEqual([3]);

      expect(await mutationRows()).toMatchObject([
        { wId: 1, turnId: TURN_A, status: "active", createdSeq: first[0]?.seq },
        { wId: 2, turnId: TURN_B, status: "active", createdSeq: first[1]?.seq },
        { wId: 3, turnId: TURN_C, status: "active", createdSeq: second[0]?.seq },
      ]);
      expect(await journal.latestActiveWrite?.(DOC_ID, THREAD_ID)).toMatchObject({
        handle: "w3",
        wId: 3,
        turnId: TURN_C,
        createdSeq: second[0]?.seq,
      });
      expect(await journal.activeWriteSummary?.(DOC_ID, THREAD_ID)).toMatchObject([
        { handle: "w1", wId: 1, turnId: TURN_A, createdSeq: first[0]?.seq },
        { handle: "w2", wId: 2, turnId: TURN_B, createdSeq: first[1]?.seq },
        { handle: "w3", wId: 3, turnId: TURN_C, createdSeq: second[0]?.seq },
      ]);
      expect(await journal.writeMinCreatedSeq?.(DOC_ID, THREAD_ID, "w1")).toBe(first[0]?.seq);
      expect(await journal.mutationsForWrite?.(DOC_ID, THREAD_ID, "w1")).toEqual([
        {
          writeId: expect.any(String),
          handle: "w1",
          wId: 1,
          turnId: TURN_A,
          createdSeq: first[0]?.seq,
          status: "active",
        },
      ]);

      const idsBeforeFailure = await updateIds();
      await expect(
        journal.appendBatch([
          {
            docId: DOC_ID,
            update: appendText(doc, " Rolled back"),
            meta: { origin: `agent:${TURN_D}`, actorTurnId: TURN_D, seq: 0 },
            mutation: { threadId: MISSING_THREAD_ID, turnId: TURN_D },
          },
        ]),
      ).rejects.toThrow();

      expect(await updateIds()).toEqual(idsBeforeFailure);
      expect((await mutationRows()).map((row) => row.wId)).toEqual([1, 2, 3]);
    });

    it("persists user and agent reversal attribution on mutation rows", async () => {
      const journal = createDrizzleJournal(db);
      const doc = new Y.Doc({ gc: false });
      doc.clientID = LIVE_CLIENT_ID;

      const [first, second] = await journal.appendBatch([
        {
          docId: DOC_ID,
          update: appendText(doc, "Alpha"),
          meta: { origin: `agent:${TURN_A}`, actorTurnId: TURN_A, seq: 0 },
          mutation: { threadId: THREAD_ID, turnId: TURN_A },
        },
        {
          docId: DOC_ID,
          update: appendText(doc, " Beta"),
          meta: { origin: `agent:${TURN_B}`, actorTurnId: TURN_B, seq: 0 },
          mutation: { threadId: THREAD_ID, turnId: TURN_B },
        },
      ]);

      await journal.persistUndo(
        DOC_ID,
        appendText(doc, " user undo"),
        [
          {
            documentId: DOC_ID,
            threadId: THREAD_ID,
            turnId: TURN_A,
            writeIds: ["w1"],
            status: "reversed",
            undoUpdateSeq: 0,
            reversedByUserId: USER_ID,
          },
        ],
        { type: "user", userId: USER_ID },
      );
      await journal.persistUndo(DOC_ID, appendText(doc, " agent undo"), [
        {
          documentId: DOC_ID,
          threadId: THREAD_ID,
          turnId: TURN_B,
          writeIds: ["w2"],
          status: "reversed",
          undoUpdateSeq: 0,
        },
      ]);

      expect(await mutationRows()).toMatchObject([
        { wId: 1, status: "reversed", createdSeq: first?.seq, reversedBy: "user" },
        { wId: 2, status: "reversed", createdSeq: second?.seq, reversedBy: "agent" },
      ]);
      expect(await journal.readReversals(DOC_ID, { threadId: THREAD_ID })).toMatchObject([
        { writeIds: ["w1"], reversedByUserId: USER_ID },
        { writeIds: ["w2"] },
      ]);
    });

    it("does not fail spuriously when concurrent batches mint w-ids for the same thread", async () => {
      const journal = createDrizzleJournal(db);

      const results = await Promise.all(
        CONCURRENT_TURNS.map((turnId, index) => {
          const doc = new Y.Doc({ gc: false });
          doc.clientID = LIVE_CLIENT_ID + index;
          return journal.appendBatch([
            {
              docId: DOC_ID,
              update: appendText(doc, `Edit ${index}`),
              meta: { origin: `agent:${turnId}`, actorTurnId: turnId, seq: 0 },
              mutation: { threadId: THREAD_ID, turnId },
            },
          ]);
        }),
      );

      expect(results).toHaveLength(CONCURRENT_TURNS.length);
      const wIds = results
        .flatMap((batch) =>
          batch.map((result) => {
            expect(result.wId).toBeDefined();
            return result.wId ?? -1;
          }),
        )
        .sort((a, b) => a - b);
      expect(wIds).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect((await mutationRows()).map((row) => row.wId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it("throws StaleDocumentSchemaError when head schema_version is older than current", async () => {
      const staleVersion = COLLAB_SCHEMA_VERSION - 1;
      expect(staleVersion).toBeGreaterThan(0);

      await db.insert(documents).values({
        id: STALE_SCHEMA_DOC_ID,
        contextSourceId: CONTEXT_SOURCE_ID,
        name: "stale-schema",
        extension: "md",
        fileType: "markdown",
      });
      await db.insert(documentYjsHeads).values({
        documentId: STALE_SCHEMA_DOC_ID,
        schemaVersion: staleVersion,
        latestUpdateSeq: 0,
      });

      const journal = createDrizzleJournal(db);
      const doc = new Y.Doc({ gc: false });
      doc.clientID = LIVE_CLIENT_ID;
      await journal.append(STALE_SCHEMA_DOC_ID, appendText(doc, "Alpha"), {
        origin: "system",
        seq: 0,
      });

      await expect(journal.read(STALE_SCHEMA_DOC_ID)).rejects.toBeInstanceOf(
        StaleDocumentSchemaError,
      );
      await expect(journal.readForReconstruction(STALE_SCHEMA_DOC_ID)).rejects.toBeInstanceOf(
        StaleDocumentSchemaError,
      );

      await db
        .update(documentYjsHeads)
        .set({ schemaVersion: COLLAB_SCHEMA_VERSION })
        .where(eq(documentYjsHeads.documentId, STALE_SCHEMA_DOC_ID));

      const snapshot = await journal.read(STALE_SCHEMA_DOC_ID);
      expect(snapshot.updates).toHaveLength(1);
      await expect(journal.readForReconstruction(STALE_SCHEMA_DOC_ID)).resolves.toBeDefined();
    });

    it("replays updates appended after checkpoint state was captured", async () => {
      const journal = createDrizzleJournal(db);
      const doc = new Y.Doc({ gc: false });
      doc.clientID = LIVE_CLIENT_ID;

      const updateA = appendText(doc, "Alpha");
      const seqA = await journal.append(DOC_ID, updateA, {
        origin: `agent:${TURN_A}`,
        actorTurnId: TURN_A,
        seq: 0,
      });
      const checkpointState = Y.encodeStateAsUpdate(doc);

      const updateB = appendText(doc, " Beta");
      const seqB = await journal.append(DOC_ID, updateB, {
        origin: `human:${USER_ID}`,
        seq: 0,
      });

      await journal.checkpoint(DOC_ID, checkpointState, seqA);

      const snapshot = await journal.read(DOC_ID);
      expect(snapshot.checkpoint).toBeInstanceOf(Uint8Array);
      expect(snapshot.updates.map((update) => update.seq)).toEqual([seqB]);
      expect(textFromSnapshot(snapshot.checkpoint, snapshot.updates)).toBe("Alpha Beta");
    });
  });
}

function appendText(doc: Y.Doc, value: string): Uint8Array {
  const text = doc.getText("body");
  const before = Y.encodeStateVector(doc);
  text.insert(text.toString().length, value);
  return Y.encodeStateAsUpdate(doc, before);
}

function textFromSnapshot(
  checkpoint: Uint8Array | null,
  updates: readonly { update: Uint8Array }[],
): string {
  const doc = new Y.Doc({ gc: false });
  if (checkpoint) Y.applyUpdate(doc, checkpoint);
  for (const update of updates) Y.applyUpdate(doc, update.update);
  return doc.getText("body").toString();
}
