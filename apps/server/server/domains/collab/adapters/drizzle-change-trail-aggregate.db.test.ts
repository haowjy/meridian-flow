/** PostgreSQL contracts for committed change-event replace-set projections. */

import type { TrailChangeV1 } from "@meridian/contracts";
import type { TurnId } from "@meridian/contracts/runtime";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  db,
  resetDatabase,
  schema,
  THREAD_ID,
  TURN_ID,
  USER_ID,
} from "../test-support/change-trail-postgres-harness.js";
import { createDrizzleChangeTrailAggregateWriter } from "./drizzle-change-trail-aggregate.js";

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

describe("change trail aggregate projections (postgres)", () => {
  beforeEach(resetDatabase);
  afterAll(closeDatabase);

  it("bounds reconciliation and revisits earlier pages to settle every trail", async () => {
    const turnIds = Array.from({ length: 101 }, () => crypto.randomUUID() as TurnId);
    await db.insert(schema.turns).values(
      turnIds.map((id) => ({
        id,
        threadId: THREAD_ID,
        parentTurnId: TURN_ID,
        role: "assistant" as const,
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
    expect((await states()).filter((state) => state === "settling")).toHaveLength(100);
    await writer.reconcileTerminalOwners();
    expect((await states()).filter((state) => state === "settling")).toHaveLength(101);
    await writer.reconcileTerminalOwners();
    expect((await states()).filter((state) => state === "settled")).toHaveLength(100);
    await writer.reconcileTerminalOwners();
    expect((await states()).filter((state) => state === "settled")).toHaveLength(101);
  });

  it("settles new trails without scanning already-settled history", async () => {
    const turnIds = Array.from({ length: 102 }, () => crypto.randomUUID() as TurnId);
    await db.insert(schema.turns).values(
      turnIds.map((id) => ({
        id,
        threadId: THREAD_ID,
        parentTurnId: TURN_ID,
        role: "assistant" as const,
        status: "complete" as const,
      })),
    );
    const freshId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    await db.insert(schema.changeTrailShells).values(
      turnIds.map((turnId, index) => ({
        id:
          index === 101
            ? freshId
            : `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        threadId: THREAD_ID,
        turnId,
        ownerKind: "turn" as const,
        state: index === 101 ? ("building" as const) : ("settled" as const),
        settledAt: index === 101 ? null : new Date(),
        changeCount: 0,
        documentCount: 0,
      })),
    );
    const writer = createDrizzleChangeTrailAggregateWriter(db);
    await writer.reconcileTerminalOwners();
    await writer.reconcileTerminalOwners();
    const [fresh] = await db
      .select()
      .from(schema.changeTrailShells)
      .where(eq(schema.changeTrailShells.id, freshId));
    expect(fresh?.state).toBe("settled");
  });

  it("reopens a shared trail when new work arrives during an active turn", async () => {
    const harness = createHarness();
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
        pushId,
        currentVersion: true,
      },
    });
    const updated = await restartedWriter.record({
      trails: [trail([{ ...initial, afterTextAtReceipt: "updated|fourth projection" }])],
      documentTitles: titles,
      settlementRefinement: {
        pushId,
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
