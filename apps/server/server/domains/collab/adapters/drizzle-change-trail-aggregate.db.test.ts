/** Consolidated test contracts; each block retains its original fixture scope. */

import { randomUUID } from "node:crypto";
import type { TrailChangeV1 } from "@meridian/contracts";
import type { TurnId } from "@meridian/contracts/runtime";
import { eq, sql } from "drizzle-orm";
import { describe as __mergedSuite, afterAll, beforeEach, expect, it } from "vitest";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "../test-support/change-trail-postgres-harness.js";
import { createDrizzleChangeTrailAggregateWriter } from "./drizzle-change-trail-aggregate.js";

__mergedSuite("drizzle-change-trail-aggregate.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/adapters/drizzle-change-trail-aggregate.db.test.ts.
  const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";

  if (!enabled || !process.env.DATABASE_URL) {
    throw new Error("DB suites require RUN_DB_TESTS=1 and DATABASE_URL");
  }

  function change(input: {
    id: string;
    pushId: string;
    clientID: number;
    before?: string | null;
    after?: string | null;
  }): TrailChangeV1 {
    return {
      changeId: input.id,
      ordinal: 0,
      documentId: ALPHA_ID,
      pushId: input.pushId,
      receiptId: null,
      kind: input.before === null ? "insert" : "modify",
      beforeBlockIdentity:
        input.before === null ? null : { documentId: ALPHA_ID, clientID: input.clientID, clock: 0 },
      afterBlockIdentity:
        input.after === null ? null : { documentId: ALPHA_ID, clientID: input.clientID, clock: 0 },
      beforeText: input.before ?? `before-${input.id}|before ${input.id}`,
      afterTextAtReceipt: input.after ?? `after-${input.id}|after ${input.id}`,
      navigation: { kind: "unavailable", reason: "fixture" },
    };
  }

  const owner = { kind: "turn" as const, threadId: THREAD_ID, turnId: TURN_ID };

  const titles = new Map([[ALPHA_ID, "Alpha"]]);

  const trail = (changes: TrailChangeV1[]) => ({
    owner,
    changes,
    counts: { changes: changes.length, documents: changes.length === 0 ? 0 : 1 },
  });

  __mergedSuite("change trail aggregate projections (postgres)", () => {
    const db = createTestDatabase();
    beforeEach(() => resetDatabase(db));
    afterAll(() => closeDatabase(db));
    it("bounds reconciliation and revisits earlier pages to settle every trail", async () => {
      await db
        .update(schema.turns)
        .set({ status: "streaming" })
        .where(eq(schema.turns.id, TURN_ID));
      const turnIds = Array.from({ length: 101 }, () => crypto.randomUUID() as TurnId);
      await db.insert(schema.turns).values(
        turnIds.map((id, index) => ({
          id,
          threadId: THREAD_ID,
          position: index + 2,
          parentTurnId: TURN_ID,
          role: "assistant" as const,
          origin: "assistant" as const,
          status: "complete" as const,
        })),
      );
      await db.insert(schema.changeTrailShells).values(
        turnIds.map((turnId) => ({
          id: crypto.randomUUID(),
          threadId: THREAD_ID,
          turnId,
          ownerKind: "turn" as const,
          changeCount: 0,
          documentCount: 0,
        })),
      );
      const writer = createDrizzleChangeTrailAggregateWriter(db);
      const states = async () =>
        (await db.select().from(schema.changeTrailShells)).map((row) => row.state);
      await writer.reconcileTerminalOwners();
      expect((await states()).filter((state) => state === "settling")).toHaveLength(99);
      await writer.reconcileTerminalOwners();
      expect((await states()).filter((state) => state === "settling")).toHaveLength(101);
      await writer.reconcileTerminalOwners();
      expect((await states()).filter((state) => state === "settled")).toHaveLength(100);
      await writer.reconcileTerminalOwners();
      expect((await states()).filter((state) => state === "settled")).toHaveLength(101);
    });
    it("reopens a shared trail when new work arrives during an active turn", async () => {
      const harness = createHarness(db);
      try {
        await harness.seedDestructivePush("shared-active-reopen");
        await db
          .update(schema.turns)
          .set({ status: "streaming" })
          .where(eq(schema.turns.id, TURN_ID));
        const id = crypto.randomUUID();
        await db.insert(schema.changeTrailShells).values({
          id,
          threadId: THREAD_ID,
          ownerKind: "shared",
          state: "settled",
          settledAt: new Date(0),
          changeCount: 0,
          documentCount: 0,
        });
        await createDrizzleChangeTrailAggregateWriter(db).reconcileTerminalOwners();
        const [shared] = await db
          .select()
          .from(schema.changeTrailShells)
          .where(eq(schema.changeTrailShells.id, id));
        expect(shared).toMatchObject({ state: "building", settledAt: null, version: 2 });
      } finally {
        harness.destroyWarmState();
      }
    });
    it("keeps cumulative changes attributed to the push that admitted each one", async () => {
      const [autoPush, manualPush] = await db
        .insert(schema.pushLineage)
        .values([
          {
            documentId: ALPHA_ID,
            branchGeneration: 1,
            journalIds: [],
            idempotencyKey: "attribution-auto",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            pushedByUserId: null,
          },
          {
            documentId: ALPHA_ID,
            branchGeneration: 1,
            journalIds: [],
            idempotencyKey: "attribution-manual",
            threadId: THREAD_ID,
            turnId: TURN_ID,
            pushedByUserId: USER_ID,
          },
        ])
        .returning({ id: schema.pushLineage.id });
      if (!autoPush || !manualPush) throw new Error("missing push fixtures");
      const writer = createDrizzleChangeTrailAggregateWriter(db);
      const autoChange = change({ id: "auto", pushId: String(autoPush.id), clientID: 10 });
      const manualChange = change({ id: "manual", pushId: String(manualPush.id), clientID: 20 });
      await writer.record({ trails: [trail([autoChange])], documentTitles: titles });
      const second = await writer.record({
        trails: [trail([manualChange])],
        documentTitles: titles,
      });
      expect(second).toMatchObject([
        {
          owner,
          documentId: ALPHA_ID,
          projectionRevision: 2,
          changes: [
            { changeId: "auto", admittedByUserId: null },
            { changeId: "manual", admittedByUserId: USER_ID },
          ],
        },
      ]);
    });
    it("retains a monotonic replace-set revision through adapter restart", async () => {
      const [push] = await db
        .insert(schema.pushLineage)
        .values({
          documentId: ALPHA_ID,
          branchGeneration: 1,
          journalIds: [],
          idempotencyKey: "revision-continuity",
          threadId: THREAD_ID,
          turnId: TURN_ID,
        })
        .returning({ id: schema.pushLineage.id });
      if (!push) throw new Error("missing push fixture");
      const pushId = String(push.id);
      const initial = change({ id: "continuity", pushId, clientID: 30 });
      const firstWriter = createDrizzleChangeTrailAggregateWriter(db);
      const first = await firstWriter.record({
        trails: [trail([initial])],
        documentTitles: titles,
      });
      const restartedWriter = createDrizzleChangeTrailAggregateWriter(db);
      const restored = await restartedWriter.record({
        trails: [trail([{ ...initial, afterTextAtReceipt: "restored|after restart" }])],
        documentTitles: titles,
        settlementRefinement: {
          pushIds: [pushId],
          currentVersion: true,
        },
      });
      const updated = await restartedWriter.record({
        trails: [trail([{ ...initial, afterTextAtReceipt: "updated|fourth projection" }])],
        documentTitles: titles,
        settlementRefinement: {
          pushIds: [pushId],
          currentVersion: true,
        },
      });
      expect([first, restored, updated].map((result) => result[0]?.projectionRevision)).toEqual([
        1, 2, 3,
      ]);
      expect(restored[0]?.changes).toEqual([
        expect.objectContaining({ afterTextAtReceipt: "restored|after restart" }),
      ]);
      expect(updated[0]?.changes).toEqual([
        expect.objectContaining({ afterTextAtReceipt: "updated|fourth projection" }),
      ]);
    });
  });
});

__mergedSuite("drizzle-trail-signals.db.test.ts", () => {
  // Merged from apps/server/server/domains/collab/adapters/drizzle-trail-signals.db.test.ts.
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  __mergedSuite("change trail dirty signals (postgres)", () => {
    const db = createTestDatabase();
    beforeEach(() => resetDatabase(db));
    afterAll(() => closeDatabase(db));
    const signals = () => db.select().from(schema.changeTrailDirtyLog);
    const _clear = () => db.delete(schema.changeTrailDirtyLog);
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
            leaseExpiresAt: new Date(Date.now() + 60000),
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
});
