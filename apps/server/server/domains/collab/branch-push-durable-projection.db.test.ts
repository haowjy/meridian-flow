/** PostgreSQL trail projection proofs across a settlement's commit faults and post-cut writer admissions. */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDrizzleChangeTrailAggregateWriter } from "./adapters/drizzle-change-trail-aggregate.js";
import type { TrailChangeV1 } from "./domain/trail-read-kernel.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  expirePendingClaims,
  resetSettlementFixture,
  runInRootDrizzleTransaction,
  schema,
} from "./test-support/branch-push-settlement-fixture.js";

describe("branch-push durable projection (postgres)", () => {
  const db = createTestDatabase();
  beforeEach(() => resetSettlementFixture(db));
  afterAll(() => closeDatabase(db));

  it("a joined revision publishes one trail version across a rolled-back completion", async () => {
    let faulted = false;
    const harness = createHarness(db, {
      afterDurableCommit: async ({ appendWriterPrefix }) => {
        await appendWriterPrefix(ALPHA_ID, "Joined writer: ");
      },
      beforeCompletionCommit: () => {
        if (faulted) return;
        faulted = true;
        throw new Error("injected fault after joined revision settlement");
      },
    });
    const branchId = await harness.seedDestructivePush("oracle-joined-recovery-version");
    await expect(harness.push(branchId)).rejects.toThrow(
      "injected fault after joined revision settlement",
    );
    // Trail settlement shares the completion transaction: the fault rolled it back.
    const [before] = await db.select().from(schema.changeTrailShells);
    expect(before?.version).toBe(1);

    await expirePendingClaims(db);
    const cold = createHarness(db);
    await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
    const [after] = await db.select().from(schema.changeTrailShells);
    expect(after?.version).toBe(2);
    harness.destroyWarmState();
    cold.destroyWarmState();
  });

  it("restores a folded-away provisional contribution after a post-cut writer admission", async () => {
    const trailPersistence = createDrizzleChangeTrailAggregateWriter(db);
    let pushId: string | null = null;
    const harness = createHarness(db, {
      afterDurableCommit: async ({ appendWriterPrefix }) => {
        const [detail] = await db.select().from(schema.changeTrailDocumentDetails);
        const [shell] = await db.select().from(schema.changeTrailShells);
        if (!detail || !shell) throw new Error("missing provisional trail contribution");
        const provisional = detail.changes as TrailChangeV1[];
        pushId = provisional[0]?.pushId ?? null;
        const inverse = provisional.map(
          (change, ordinal): TrailChangeV1 => ({
            ...change,
            changeId: `${change.changeId}:inverse`,
            ordinal,
            pushId: "fold-away",
            receiptId: null,
            kind:
              change.afterTextAtReceipt === null
                ? "insert"
                : change.beforeText === null
                  ? "delete"
                  : "modify",
            beforeText: change.afterTextAtReceipt,
            afterTextAtReceipt: change.beforeText,
          }),
        );
        await runInRootDrizzleTransaction(db, () =>
          trailPersistence.record({
            trails: [
              {
                owner:
                  shell.ownerKind === "turn" && shell.turnId
                    ? { kind: "turn", threadId: shell.threadId, turnId: shell.turnId }
                    : { kind: "shared", threadId: shell.threadId, turnId: null },
                changes: inverse,
                counts: {
                  changes: inverse.length,
                  documents: new Set(inverse.map((change) => change.documentId)).size,
                },
              },
            ],
            documentTitles: new Map([[detail.documentId, detail.documentTitle]]),
          }),
        );
        expect(await db.select().from(schema.changeTrailDocumentDetails)).toEqual([]);
        await appendWriterPrefix(ALPHA_ID, "Joined writer: ");
      },
    });
    const branchId = await harness.seedDestructivePush("oracle-folded-away-restoration");

    await expect(harness.push(branchId)).resolves.toMatchObject({ status: "pushed" });

    expect(pushId).not.toBeNull();
    const restored = await db.select().from(schema.changeTrailDocumentDetails);
    expect(restored).toEqual([
      expect.objectContaining({
        documentId: ALPHA_ID,
        documentTitle: "alpha",
        changes: expect.arrayContaining([expect.objectContaining({ pushId })]),
      }),
    ]);
    harness.destroyWarmState();
  });
});
