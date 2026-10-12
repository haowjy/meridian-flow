/** Owner invalidation's durable transaction and cross-domain lock contract. */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { lockThreadForMutation } from "../../../shared/thread-work-lock.js";
import { lockWorksInIdOrder } from "../../../shared/work-lifecycle-lock.js";
import { createDrizzleTurnRepository } from "../../threads/adapters/drizzle/turn-repository.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  PROJECT_ID,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
  WORK_ID,
} from "../test-support/change-trail-postgres-harness.js";
import { createDrizzleChangeTrailAggregateWriter } from "./drizzle-change-trail-aggregate.js";
import { type ReceiptWrite, recordDocumentEdit } from "./drizzle-document-edits.js";
import { invalidateTrailOwners, runWithTrailDrafts } from "./drizzle-trail-owners.js";

const receipt: ReceiptWrite["receipts"][number] = {
  update: new Uint8Array([0, 0]),
  effect: { inserted: [], deleted: [] },
  frontier: {},
  aliases: [],
  origin: { kind: "live", seq: 1 },
};

if (!process.env.DATABASE_URL || !["1", "true"].includes(process.env.RUN_DB_TESTS ?? "")) {
  throw new Error("DB suites require RUN_DB_TESTS=1 and DATABASE_URL");
}

describe("trail owner command seams (postgres)", () => {
  const db = createTestDatabase();
  const revision = async () =>
    (await db.select().from(schema.turns).where(eq(schema.turns.id, TURN_ID)))[0]
      .trailDirtyRevision;
  beforeEach(() => resetDatabase(db));
  afterAll(() => closeDatabase(db));

  it.each([
    "receipt, parts and journal admission",
    "journal insertion",
    "journal disposition and placement",
    "publication and settlement staging",
    "settlement completion",
    "turn lifecycle",
  ])("durably invalidates through the %s command boundary", async (path) => {
    let release!: () => void;
    let admitted!: () => void;
    const staged = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness(
      db,
      path.includes("settlement")
        ? {
            async afterDurableCommit() {
              admitted();
              await resume;
            },
          }
        : undefined,
    );
    let completing: Promise<unknown> | undefined;
    try {
      let before = await revision();
      let threadBefore = (
        await db.select().from(schema.threads).where(eq(schema.threads.id, THREAD_ID))
      )[0].trailDirtyRevision;
      if (path === "turn lifecycle") {
        await createDrizzleTurnRepository(db, null).updateStatus(TURN_ID, { status: "error" });
      } else if (path === "receipt, parts and journal admission") {
        await harness.seedDestructivePush("owner-receipt");
        expect((await db.select().from(schema.documentEditParts)).length).toBeGreaterThan(0);
      } else {
        const branchId = await harness.seedDestructivePush("owner-command");
        before = await revision();
        threadBefore = (
          await db.select().from(schema.threads).where(eq(schema.threads.id, THREAD_ID))
        )[0].trailDirtyRevision;
        const f = harness.crossWorkProbeFixture();
        if (path === "journal insertion") {
          const branch = await f.branchStore.getBranch(branchId);
          if (!branch) throw new Error("branch missing");
          await f.branchStore.appendJournal({
            branchId,
            generation: branch.generation,
            updateData: new Uint8Array([0, 0]),
            source: "agent",
            threadId: THREAD_ID,
            turnId: TURN_ID,
          });
        } else if (path === "journal disposition and placement") {
          await f.collab.draftReview.discardWorkDraft({
            workId: WORK_ID,
            documentId: ALPHA_ID,
            draftId: branchId,
            userId: USER_ID,
          });
          expect(
            (await db.select().from(schema.documentEditParts)).some(
              (part) => part.placement.kind === "discarded",
            ),
          ).toBe(true);
        } else {
          completing = harness.push(branchId);
          await staged;
          if (path === "settlement completion") {
            before = await revision();
            threadBefore = (
              await db.select().from(schema.threads).where(eq(schema.threads.id, THREAD_ID))
            )[0].trailDirtyRevision;
            release();
            await completing;
          }
        }
      }
      expect(await revision()).toBeGreaterThan(before);
      expect(
        (await db.select().from(schema.threads).where(eq(schema.threads.id, THREAD_ID)))[0]
          .trailDirtyRevision,
      ).toBeGreaterThan(threadBefore);
    } finally {
      release?.();
      await completing;
      harness.destroyWarmState();
    }
  });

  it("serializes a receipt behind lifecycle's thread lock without taking the turn first", async () => {
    const other = createTestDatabase();
    let release!: () => void;
    let locked!: () => void;
    let receiptPid!: (pid: number) => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pidReady = new Promise<number>((resolve) => {
      receiptPid = resolve;
    });
    const lifecycle = db.transaction(async (tx) => {
      await lockThreadForMutation(tx, THREAD_ID);
      locked();
      await resume;
      await invalidateTrailOwners(tx, { turnIds: [TURN_ID] });
      await tx.update(schema.turns).set({ status: "error" }).where(eq(schema.turns.id, TURN_ID));
    });
    await ready;
    const writing = other.transaction(async (tx) => {
      const [pid] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      receiptPid(pid.pid);
      await invalidateTrailOwners(tx, { owners: [{ threadId: THREAD_ID, turnId: TURN_ID }] });
      await recordDocumentEdit(tx, {
        documentId: ALPHA_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        actor: "agent",
        receipts: [receipt],
      });
    });
    try {
      const pid = await pidReady;
      await expect
        .poll(async () => {
          const [row] = await db.execute<{ blocked: boolean }>(
            sql`SELECT cardinality(pg_blocking_pids(${pid})) > 0 AS blocked`,
          );
          return row.blocked;
        })
        .toBe(true);
      release();
      await Promise.all([lifecycle, writing]);
      expect((await db.select().from(schema.turns))[0].status).toBe("error");
      expect(await db.select().from(schema.documentEdits)).toHaveLength(1);
    } finally {
      release();
      await Promise.allSettled([lifecycle, writing]);
      await closeDatabase(other);
    }
  });

  it("refuses an expanded owner cut without acquiring owner locks after Work", async () => {
    const harness = createHarness(db);
    const other = createTestDatabase();
    const threadId = crypto.randomUUID();
    const turnId = crypto.randomUUID();
    let release!: () => void;
    let ready!: (pid: number) => void;
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = new Promise<number>((resolve) => {
      ready = resolve;
    });
    let gate: Promise<unknown> | undefined;
    let command: Promise<unknown> | undefined;
    try {
      const branchId = await harness.seedDestructivePush("owner-cut");
      const branch = await harness.crossWorkProbeFixture().branchStore.getBranch(branchId);
      if (!branch) throw new Error("branch missing");
      await db.insert(schema.threads).values({
        id: threadId,
        rootThreadId: threadId,
        projectId: PROJECT_ID,
        createdByUserId: USER_ID,
        kind: "primary",
        title: "Concurrent owner",
      });
      await db.insert(schema.turns).values({
        id: turnId,
        threadId,
        position: 1,
        role: "assistant",
        origin: "assistant",
        status: "complete",
      });
      const before = await revision();
      gate = db.transaction(async (tx) => {
        await invalidateTrailOwners(tx, { owners: [{ threadId, turnId }] });
        await lockWorksInIdOrder(tx, [WORK_ID]);
        const [row] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        ready(row.pid);
        await resume;
        await tx.insert(schema.branchWriteJournal).values({
          branchId,
          generation: branch.generation,
          threadId,
          turnId,
          source: "agent",
          draftBaseUpdateSeq: 0,
          updateData: Buffer.from([0, 0]),
        });
      });
      const pid = await gated;
      command = runWithTrailDrafts(other, { branchIds: [branchId] }, async () => {
        throw new Error("must not reach the write with an unlocked new owner");
      });
      // Observe a real lock wait, rather than relying on scheduling or sleeps.
      await expect
        .poll(async () => {
          const [row] = await db.execute<{ waiting: boolean }>(sql`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
        ) AS waiting`);
          return row.waiting;
        })
        .toBe(true);
      release();
      await gate;
      await expect(command).rejects.toMatchObject({ branchId });
      // The refused command's earlier revision write rolled back with it.
      expect(await revision()).toBe(before);
    } finally {
      release?.();
      await Promise.allSettled([gate, command]);
      harness.destroyWarmState();
      await closeDatabase(other);
    }
  });

  it("does not acknowledge an invalidation committed after the reconciler's read cut", async () => {
    const worker = createDrizzleChangeTrailAggregateWriter(db);
    await worker.reconcileTerminalOwners();
    const captured = await revision();
    const gate = await db.$client.reserve();
    let reconciling: Promise<unknown> | undefined;
    let held = false;
    try {
      await db.execute(sql`CREATE FUNCTION pause_trail_settlement() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.state = 'settled' THEN PERFORM pg_advisory_xact_lock(7130040); END IF; RETURN NEW; END $$`);
      await db.execute(sql`CREATE TRIGGER pause_trail_settlement BEFORE UPDATE ON change_trail_shells
        FOR EACH ROW EXECUTE FUNCTION pause_trail_settlement()`);
      await gate`SELECT pg_advisory_lock(7130040)`;
      held = true;
      reconciling = worker.reconcileTerminalOwners();
      await expect
        .poll(async () => {
          const [row] = await db.execute<{ waiting: boolean }>(sql`SELECT EXISTS (
          SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND objid = 7130040 AND NOT granted
        ) AS waiting`);
          return row.waiting;
        })
        .toBe(true);
      await db.transaction(async (tx) => {
        await invalidateTrailOwners(tx, { owners: [{ threadId: THREAD_ID, turnId: TURN_ID }] });
        await recordDocumentEdit(tx, {
          documentId: ALPHA_ID,
          threadId: THREAD_ID,
          turnId: TURN_ID,
          actor: "agent",
          receipts: [receipt],
        });
      });
      await gate`SELECT pg_advisory_unlock(7130040)`;
      held = false;
      await reconciling;
      const [shell] = await db.select().from(schema.changeTrailShells);
      expect(shell.reconciledRevision).toBe(captured);
      expect(await revision()).toBeGreaterThan(shell.reconciledRevision);
    } finally {
      if (held) await gate`SELECT pg_advisory_unlock(7130040)`;
      gate.release();
      await reconciling;
      await db.execute(sql`DROP TRIGGER IF EXISTS pause_trail_settlement ON change_trail_shells`);
      await db.execute(sql`DROP FUNCTION IF EXISTS pause_trail_settlement()`);
    }
    const cold = createTestDatabase();
    try {
      const restarted = createDrizzleChangeTrailAggregateWriter(cold);
      await restarted.reconcileTerminalOwners();
      await restarted.reconcileTerminalOwners();
      const [shell] = await cold.select().from(schema.changeTrailShells);
      expect(shell.reconciledRevision).toBe(await revision());
    } finally {
      await closeDatabase(cold);
    }
  });

  it("follows ownerless inverse and rollback targets on admission and later placement after restart", async () => {
    const original = await db.transaction(async (tx) => {
      await invalidateTrailOwners(tx, { owners: [{ threadId: THREAD_ID, turnId: TURN_ID }] });
      return recordDocumentEdit(tx, {
        documentId: ALPHA_ID,
        threadId: THREAD_ID,
        turnId: TURN_ID,
        actor: "agent",
        receipts: [receipt],
      });
    });
    const settle = async () => {
      const cold = createTestDatabase();
      try {
        const worker = createDrizzleChangeTrailAggregateWriter(cold);
        await worker.reconcileTerminalOwners();
        await worker.reconcileTerminalOwners();
        const [shell] = await cold.select().from(schema.changeTrailShells);
        expect(shell.reconciledRevision).toBe(await revision());
        expect(shell.state).toBe("settled");
      } finally {
        await closeDatabase(cold);
      }
    };
    await settle();
    let target = original;
    for (const kind of ["undo", "rollback"] as const) {
      const before = await revision();
      const inverse = await db.transaction(async (tx) => {
        // Admission knows its immutable target IDs before taking document locks.
        await invalidateTrailOwners(tx, { editIds: [target] });
        return recordDocumentEdit(tx, {
          documentId: ALPHA_ID,
          actor: kind === "undo" ? "human" : "system",
          kind,
          receipts: [
            { ...receipt, targets: [{ editId: target, ordinal: 0, direction: "invert" }] },
          ],
        });
      });
      expect(await revision()).toBeGreaterThan(before);
      const [edit] = await db
        .select()
        .from(schema.documentEdits)
        .where(eq(schema.documentEdits.id, inverse));
      expect(edit).toMatchObject({ threadId: null, turnId: null });
      await settle();
      const admitted = await revision();
      await db.transaction(async (tx) => {
        await invalidateTrailOwners(tx, { editIds: [inverse] });
        await tx
          .update(schema.documentEditParts)
          .set({ placement: { kind: "retired" } })
          .where(eq(schema.documentEditParts.editId, inverse));
      });
      expect(await revision()).toBeGreaterThan(admitted);
      await settle();
      target = inverse;
    }
  });
});
