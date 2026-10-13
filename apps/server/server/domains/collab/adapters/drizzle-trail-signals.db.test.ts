import { randomUUID } from "node:crypto";
/** Dirty-signal capture, semantic readiness, and exact-cut acknowledgement on PostgreSQL. */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
} from "../test-support/change-trail-postgres-harness.js";
import { createDrizzleChangeTrailAggregateWriter } from "./drizzle-change-trail-aggregate.js";

const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("change trail dirty signals (postgres)", () => {
  const db = createTestDatabase();
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeDatabase(db));
  const signals = () => db.select().from(schema.changeTrailDirtyLog);
  const clear = () => db.delete(schema.changeTrailDirtyLog);
  const shell = async () => (await db.select().from(schema.changeTrailShells))[0];
  const writer = () => createDrizzleChangeTrailAggregateWriter(db);
  const receipt = async (target?: string) => {
    const [edit] = await db
      .insert(schema.documentEdits)
      .values({
        documentId: ALPHA_ID,
        actor: target ? "human" : "agent",
        kind: target ? "undo" : "write",
        ...(target ? {} : { threadId: THREAD_ID, turnId: TURN_ID }),
      })
      .returning();
    await db.insert(schema.documentEditParts).values({
      editId: edit.id,
      ordinal: 0,
      update: Buffer.from([0, 0]),
      effect: { inserted: [], deleted: [] },
      frontier: {},
      targets: target ? [{ editId: target, ordinal: 0, direction: "invert" }] : [],
      origin: { kind: "live", seq: 1 },
      placement: { kind: "live", seq: 1 },
    });
    return edit.id;
  };

  it("captures receipt/part and recursively targeted ownerless inverse placement", async () => {
    await clear();
    const original = await receipt();
    expect(await signals()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ turnId: TURN_ID }),
        expect.objectContaining({ turnId: null }),
      ]),
    );
    const inverse = await receipt(original);
    await clear();
    const rollback = await receipt(inverse);
    expect(await signals()).toEqual(
      expect.arrayContaining([expect.objectContaining({ turnId: TURN_ID })]),
    );
    await clear();
    await db
      .update(schema.documentEditParts)
      .set({ placement: { kind: "discarded" } })
      .where(eq(schema.documentEditParts.editId, rollback));
    expect(await signals()).toEqual(
      expect.arrayContaining([expect.objectContaining({ turnId: TURN_ID })]),
    );
    expect(
      (await db.select().from(schema.documentEdits).where(eq(schema.documentEdits.id, rollback)))[0]
        .turnId,
    ).toBeNull();
  });

  it("captures journal insertion/disposition, publication, settlement and lifecycle", async () => {
    const harness = createHarness(db);
    try {
      await clear();
      const branch = await harness.seedDestructivePush("signals");
      expect(await signals()).not.toEqual([]);
      await clear();
      await db.update(schema.branchWriteJournal).set({ status: "rollback_pending" });
      expect(await signals()).not.toEqual([]);
      await db.update(schema.branchWriteJournal).set({ status: "active" });
      await clear();
      await harness.push(branch);
      expect(await signals()).not.toEqual([]);
      await clear();
      await db.update(schema.turns).set({ status: "error" }).where(eq(schema.turns.id, TURN_ID));
      expect(await signals()).not.toEqual([]);
    } finally {
      harness.destroyWarmState();
    }
  });

  it("allows receipt signals while lifecycle holds both parent NO KEY UPDATE locks", async () => {
    const held = gate();
    const release = gate();
    const lifecycle = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM threads WHERE id = ${THREAD_ID} FOR NO KEY UPDATE`);
      await tx.execute(sql`SELECT id FROM turns WHERE id = ${TURN_ID} FOR NO KEY UPDATE`);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    try {
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
        await tx.insert(schema.documentEdits).values({
          documentId: ALPHA_ID,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          actor: "agent",
          kind: "write",
        });
      });
    } finally {
      release.resolve();
      await lifecycle;
    }
  });

  it("retains a lower sequence committed after the worker cut and reopens on cold restart", async () => {
    await writer().reconcileTerminalOwners();
    await writer().reconcileTerminalOwners();
    const inserted = gate();
    const release = gate();
    let low = 0n;
    const producer = db.transaction(async (tx) => {
      const [signal] = await tx
        .insert(schema.changeTrailDirtyLog)
        .values({ threadId: THREAD_ID, turnId: TURN_ID })
        .returning();
      low = signal.seq;
      inserted.resolve();
      await release.promise;
    });
    await inserted.promise;
    try {
      const [high] = await db
        .insert(schema.changeTrailDirtyLog)
        .values({ threadId: THREAD_ID, turnId: TURN_ID })
        .returning();
      expect(high.seq).toBeGreaterThan(low);
      await writer().reconcileTerminalOwners();
      await writer().reconcileTerminalOwners();
      expect(await signals()).toEqual([]);
    } finally {
      release.resolve();
      await producer;
    }
    expect(await signals()).toEqual([expect.objectContaining({ seq: low })]);
    const version = (await shell()).version;
    const cold = createTestDatabase();
    try {
      const aggregate = createDrizzleChangeTrailAggregateWriter(cold);
      await aggregate.reconcileTerminalOwners();
      await aggregate.reconcileTerminalOwners();
      expect(await shell()).toMatchObject({ state: "settled", version: version + 3 });
      expect(await signals()).toEqual([]);
    } finally {
      await closeDatabase(cold);
    }
  });

  it("rolls consumption back with a failed shell/outbox transaction", async () => {
    const before = await signals();
    await db.execute(sql`CREATE FUNCTION fail_trail_cut() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'cut rollback'; END $$`);
    await db.execute(sql`CREATE TRIGGER fail_trail_cut BEFORE UPDATE ON change_trail_shells
      FOR EACH ROW EXECUTE FUNCTION fail_trail_cut()`);
    try {
      await expect(writer().reconcileTerminalOwners()).rejects.toThrow();
      expect(await signals()).toEqual(before);
      expect(await db.select().from(schema.changeTrailShells)).toEqual([]);
      expect(await db.select().from(schema.changeTrailDeliveryOutbox)).toEqual([]);
    } finally {
      await db.execute(sql`DROP TRIGGER fail_trail_cut ON change_trail_shells`);
      await db.execute(sql`DROP FUNCTION fail_trail_cut()`);
    }
    await writer().reconcileTerminalOwners();
    await writer().reconcileTerminalOwners();
    expect(await shell()).toMatchObject({ state: "settled" });
  });

  it("holds the original turn settling for an inverse-only publication and rollback", async () => {
    const harness = createHarness(db);
    try {
      const branchId = await harness.seedDestructivePush("semantic-readiness");
      const original = await receipt();
      const inverse = await receipt(original);
      const [journal] = await db
        .insert(schema.branchWriteJournal)
        .values({
          branchId,
          generation: 1,
          source: "writer",
          updateData: Buffer.from([0, 0]),
          draftBaseUpdateSeq: 0,
          updateMeta: { documentEdit: { editId: inverse } },
          status: "rollback_pending",
        })
        .returning();
      const [push] = await db
        .insert(schema.pushLineage)
        .values({
          documentId: ALPHA_ID,
          branchGeneration: 1,
          journalIds: [journal.id],
          idempotencyKey: "inverse-only",
        })
        .returning();
      const [batch] = await db
        .insert(schema.branchPushSettlementBatches)
        .values({
          id: randomUUID(),
          state: "pending",
          claimToken: randomUUID(),
          claimKind: "warm",
          claimedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        })
        .returning();
      if (!batch) throw new Error("batch not created");
      await db.insert(schema.branchPushSettlementOutbox).values({
        pushId: push.id,
        batchId: batch.id,
        documentId: ALPHA_ID,
        documentTitle: "Alpha",
        lockCutUpdate: Buffer.from([0, 0]),
        pushUpdate: Buffer.from([0, 0]),
        trailSeed: {},
      });
      await writer().reconcileTerminalOwners();
      await writer().reconcileTerminalOwners();
      expect(await shell()).toMatchObject({ state: "settling" });
      await db
        .update(schema.branchWriteJournal)
        .set({ status: "pushed" })
        .where(eq(schema.branchWriteJournal.id, journal.id));
      await writer().reconcileTerminalOwners();
      expect(await shell()).toMatchObject({ state: "settling" });
      await db
        .update(schema.branchPushSettlementBatches)
        .set({
          state: "completed",
          completedAt: new Date(),
          claimToken: null,
          claimKind: null,
          claimedAt: null,
          leaseExpiresAt: null,
        })
        .where(eq(schema.branchPushSettlementBatches.id, batch.id));
      await writer().reconcileTerminalOwners();
      expect(await shell()).toMatchObject({ state: "settled" });
    } finally {
      harness.destroyWarmState();
    }
  });
});
