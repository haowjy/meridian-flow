/**
 * What a settlement batch that keeps failing tells an operator: one stuck event at the
 * threshold, one event per transition to blocked, and a block only for corruption.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { EventSink } from "../observability/index.js";
import {
  ALPHA_ID,
  BETA_ID,
  claimProbeStore,
  closeDatabase,
  createHarness,
  createTestDatabase,
  expirePendingClaims,
  resetSettlementFixture,
  schema,
} from "./test-support/branch-push-settlement-fixture.js";

describe("settlement failure reporting (postgres)", () => {
  const db = createTestDatabase();
  beforeEach(() => resetSettlementFixture(db));
  afterAll(async () => {
    await resetSettlementFixture(db);
    await closeDatabase(db);
  });

  function collectingSink() {
    const events: Array<{ name: string; level: string; payload: unknown; correlation?: unknown }> =
      [];
    const record = (event: (typeof events)[number]) =>
      events.push({
        name: event.name,
        level: event.level,
        payload: event.payload,
        correlation: event.correlation,
      });
    const sink: EventSink = {
      emit: record,
      emitBatch: (batch) => batch.forEach(record),
      flush: async () => {},
    };
    return { sink, events };
  }

  /** A pending batch for the document, its claim released and its backoff elapsed. */
  async function seedPendingBatch(documentId: typeof ALPHA_ID | typeof BETA_ID, name: string) {
    const harness = createHarness(db, {
      afterDurableCommit: async () => {
        throw new Error("stop after the batch is staged");
      },
    });
    const draftId = await harness.seedDestructivePush(name, documentId);
    await expect(harness.push(draftId)).rejects.toThrow("stop after the batch is staged");
    harness.destroyWarmState();
    await expirePendingClaims(db, documentId);
    const [{ batchId }] = await db
      .select({ batchId: schema.branchPushSettlementOutbox.batchId })
      .from(schema.branchPushSettlementOutbox)
      .where(eq(schema.branchPushSettlementOutbox.documentId, documentId));
    return batchId as string;
  }

  async function batchRow(batchId: string) {
    const [row] = await db
      .select()
      .from(schema.branchPushSettlementBatches)
      .where(eq(schema.branchPushSettlementBatches.id, batchId));
    return row;
  }

  it("calls a batch stuck once, at the threshold, and warns before and after", async () => {
    const batchId = await seedPendingBatch(ALPHA_ID, "stuck-once");
    const { sink, events } = collectingSink();
    const store = claimProbeStore(db, sink);
    await db
      .update(schema.branchPushSettlementBatches)
      .set({ attemptCount: 8 })
      .where(eq(schema.branchPushSettlementBatches.id, batchId));
    for (const attempt of [9, 10, 11]) {
      await db
        .update(schema.branchPushSettlementBatches)
        .set({ availableAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(schema.branchPushSettlementBatches.id, batchId));
      const claimed = await store.claimRecoverableBatch({
        batchId,
        token: "00000000-0000-4000-8000-0000000005a1",
      });
      if (!claimed) throw new Error(`attempt ${attempt} did not claim the batch`);
      await store.recordFailure({
        batchId,
        claim: claimed.claim,
        stage: "execute",
        error: "still failing",
      });
    }
    expect(events.map(({ name, level }) => `${level} ${name}`)).toEqual([
      "warn settlement.batch_failed",
      "error settlement.batch_stuck",
      "warn settlement.batch_failed",
    ]);
  });

  it("reports every transition to blocked: the store's block and a corrupt authority at claim", async () => {
    const { sink, events } = collectingSink();
    const store = claimProbeStore(db, sink);
    const blockedBatch = await seedPendingBatch(ALPHA_ID, "block-store");
    const claimed = await store.claimRecoverableBatch({
      batchId: blockedBatch,
      token: "00000000-0000-4000-8000-0000000005b1",
    });
    if (!claimed) throw new Error("the batch was not claimable");
    await expect(
      store.block({
        batchId: blockedBatch,
        claim: claimed.claim,
        code: "corrupt_state",
        error: "projection is corrupt",
      }),
    ).resolves.toBe(true);

    const corruptBatch = await seedPendingBatch(BETA_ID, "block-claim");
    // The seed's own fields are valid; only the shared notice parser rejects it,
    // and that nested failure must still be named as corruption, not retried.
    const uuid = "00000000-0000-4000-8000-0000000005d1";
    await db.update(schema.branchPushSettlementOutbox).set({
      trailSeed: {
        documentId: uuid,
        documentTitle: "t",
        receiptId: uuid,
        threadIds: [],
        journalOwners: [],
        changes: [],
        transactionalNotice: {},
      },
    });
    await expect(
      store.claimRecoverableBatch({
        batchId: corruptBatch,
        token: "00000000-0000-4000-8000-0000000005b2",
      }),
    ).rejects.toThrow(/Invalid durable trail seed/);

    expect(
      events.map(({ name, level, correlation, payload }) => ({
        name,
        level,
        correlation,
        code: (payload as { code?: string }).code,
      })),
    ).toEqual([
      {
        name: "settlement.batch_blocked",
        level: "error",
        correlation: { batchId: blockedBatch },
        code: "corrupt_state",
      },
      {
        name: "settlement.batch_blocked",
        level: "error",
        correlation: { batchId: corruptBatch },
        code: "corrupt_settlement_authority",
      },
    ]);
    expect((await batchRow(corruptBatch))?.state).toBe("blocked");
  });

  it("retries a transient read error at claim instead of blocking the batch", async () => {
    const batchId = await seedPendingBatch(ALPHA_ID, "transient-read");
    const { sink, events } = collectingSink();
    let failNextRead = true;
    const flaky = new Proxy(db, {
      get(target, key) {
        if (key === "select" && failNextRead) {
          failNextRead = false;
          return () => {
            throw new Error("connection reset");
          };
        }
        return Reflect.get(target, key);
      },
    });
    await expect(
      claimProbeStore(flaky, sink).claimRecoverableBatch({
        batchId,
        token: "00000000-0000-4000-8000-0000000005c1",
      }),
    ).rejects.toThrow("connection reset");
    expect(await batchRow(batchId)).toMatchObject({
      state: "pending",
      attemptCount: 1,
      claimToken: null,
    });
    expect(events).toEqual([
      expect.objectContaining({
        name: "settlement.batch_failed",
        level: "warn",
        payload: expect.objectContaining({ stage: "claim", attemptCount: 1 }),
      }),
    ]);
  });
});
