import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { drizzleFileAccess } from "../../test-support/file-grants.js";
import { createDrizzleChangeTrailAggregateWriter } from "./adapters/drizzle-change-trail-aggregate.js";
import { createDrizzleChangeTrailReader } from "./adapters/drizzle-change-trail-reader.js";
import {
  ALPHA_ID,
  closeDatabase,
  createTestDatabase,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "./test-support/change-trail-postgres-harness.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
if (!enabled || !process.env.DATABASE_URL) {
  throw new Error("DB suites require RUN_DB_TESTS=1 and DATABASE_URL");
}

describe("change trail (postgres)", () => {
  const db = createTestDatabase();
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeDatabase(db));

  it("retains captured trail prose after the file is permanently deleted", async () => {
    const trailId = "00000000-0000-4000-8000-000000000810";
    await db.insert(schema.changeTrailShells).values({
      id: trailId,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      ownerKind: "turn",
      changeCount: 1,
      documentCount: 1,
    });
    await db
      .insert(schema.changeTrailDocumentOccurrences)
      .values({ trailId, documentId: ALPHA_ID });
    await db.insert(schema.changeTrailDocumentDetails).values({
      trailId,
      documentId: ALPHA_ID,
      documentTitle: "Deleted chapter",
      changes: [
        {
          changeId: "captured-change",
          ordinal: 0,
          documentId: ALPHA_ID,
          pushId: null,
          receiptId: null,
          kind: "delete",
          beforeText: "deleted-block|Captured after reload.",
          afterTextAtReceipt: null,
          beforeBlockIdentity: null,
          afterBlockIdentity: null,
          navigation: { kind: "unavailable", reason: "document_deleted" },
        },
      ],
    });
    await db
      .update(schema.documents)
      .set({ deletionReason: "deleted", deletedAt: new Date() })
      .where(eq(schema.documents.id, ALPHA_ID));

    const reader = createDrizzleChangeTrailReader(db, drizzleFileAccess(db));
    await expect(
      reader.readDetails({ threadId: THREAD_ID, trailId, userId: USER_ID }),
    ).resolves.toEqual([
      expect.objectContaining({
        documentId: ALPHA_ID,
        anchorState: "deleted",
        changes: [
          expect.objectContaining({
            beforeText: "deleted-block|Captured after reload.",
          }),
        ],
      }),
    ]);
  });

  it("returns no protected trail detail when document authorization fails", async () => {
    const trailId = "00000000-0000-4000-8000-000000000811";
    await db.insert(schema.changeTrailShells).values({
      id: trailId,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      ownerKind: "turn",
      changeCount: 1,
      documentCount: 1,
    });
    await db
      .insert(schema.changeTrailDocumentOccurrences)
      .values({ trailId, documentId: ALPHA_ID });
    await db.insert(schema.changeTrailDocumentDetails).values({
      trailId,
      documentId: ALPHA_ID,
      documentTitle: "Protected chapter",
      changes: [
        {
          changeId: "protected-change",
          ordinal: 0,
          documentId: ALPHA_ID,
          pushId: null,
          receiptId: null,
          kind: "delete",
          beforeText: "protected-block|Protected prose.",
          afterTextAtReceipt: null,
          beforeBlockIdentity: null,
          afterBlockIdentity: null,
          navigation: { kind: "unavailable", reason: "test" },
        },
      ],
    });

    const reader = createDrizzleChangeTrailReader(db, drizzleFileAccess(db));
    await expect(
      reader.readDetails({
        threadId: THREAD_ID,
        trailId,
        userId: "00000000-0000-4000-8000-000000000812" as never,
      }),
    ).resolves.toEqual([]);

    const revokedAccess = { historyAccess: async () => null };
    await expect(
      createDrizzleChangeTrailReader(db, revokedAccess).readDetails({
        threadId: THREAD_ID,
        trailId,
        userId: USER_ID,
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    "complete",
    "cancelled",
    "error",
  ])("settles an empty %s turn after restart", async (status) => {
    await db.update(schema.turns).set({ status }).where(eq(schema.turns.id, TURN_ID));
    const coldDb = createTestDatabase();
    try {
      const cold = createDrizzleChangeTrailAggregateWriter(coldDb);
      await cold.reconcileTerminalOwners();
      await cold.reconcileTerminalOwners();
      const [shell] = await coldDb.select().from(schema.changeTrailShells);
      expect(shell).toMatchObject({
        state: "settled",
        changeCount: 0,
        documentCount: 0,
      });
    } finally {
      await closeDatabase(coldDb);
    }
  });

  it("commits receipt invalidation atomically, then recovers without a warm owner", async () => {
    const revision = async () => (await db.select().from(schema.changeTrailDirtyLog)).length;
    const initial = await revision();
    const receipt = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
      const [edit] = await tx
        .insert(schema.documentEdits)
        .values({
          documentId: ALPHA_ID,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          actor: "agent",
          kind: "write",
        })
        .returning();
      await tx.insert(schema.documentEditParts).values({
        editId: edit.id,
        ordinal: 0,
        update: Buffer.from([0, 0]),
        effect: { inserted: [], deleted: [] },
        frontier: {},
        origin: { kind: "live", seq: 1 },
        placement: { kind: "live", seq: 1 },
      });
      return edit.id;
    };
    await expect(
      db.transaction(async (tx) => {
        await receipt(tx);
        throw new Error("receipt rollback");
      }),
    ).rejects.toThrow("receipt rollback");
    expect(await revision()).toBe(initial);
    expect(await db.select().from(schema.documentEdits)).toEqual([]);
    await db.transaction(receipt);
    expect(await revision()).toBeGreaterThan(initial);
    const coldDb = createTestDatabase();
    try {
      const cold = createDrizzleChangeTrailAggregateWriter(coldDb);
      await cold.reconcileTerminalOwners();
      await cold.reconcileTerminalOwners();
      expect(await coldDb.select().from(schema.changeTrailShells)).toEqual([
        expect.objectContaining({ state: "settled" }),
      ]);
    } finally {
      await closeDatabase(coldDb);
    }
  });
});
