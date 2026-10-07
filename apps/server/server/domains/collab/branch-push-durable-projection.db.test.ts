/** PostgreSQL canonical replay, trail projection and sweep attribution proofs. */

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDrizzleChangeTrailAggregateWriter } from "./adapters/drizzle-change-trail-aggregate.js";
import type { TrailChangeV1 } from "./domain/trail-read-kernel.js";
import {
  ALPHA_ID,
  createHarness,
  db,
  expectLiveSweepOnly,
  expectSweepClassification,
  expirePendingClaims,
  OTHER_USER_ID,
  observeSettlement,
  runInRootDrizzleTransaction,
  schema,
  setupSettlementFixture,
  USER_ID,
} from "./test-support/branch-push-settlement-fixture.js";

setupSettlementFixture();
describe("branch-push durable projection (postgres)", () => {
  it("replays the canonical whole branch when an active edit depends on a discarded row", async () => {
    const warm = createHarness();
    const branchId = await warm.seedDiscardedDependencyPush();
    await expect(warm.push(branchId)).resolves.toMatchObject({ status: "pushed" });
    await expect(warm.liveMarkdown(ALPHA_ID)).resolves.toBe("Dependency base. survivor\n");
    warm.destroyWarmState();

    const cold = createHarness();
    await expect(cold.liveMarkdown(ALPHA_ID)).resolves.toBe("Dependency base. survivor\n");
    expect(
      await db
        .select({ originType: schema.documentYjsUpdates.originType })
        .from(schema.documentYjsUpdates)
        .orderBy(schema.documentYjsUpdates.id),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ originType: "reconcile" })]));
    cold.destroyWarmState();
  });

  it("recovery refines the trail version already settled for the same joined revision", async () => {
    let faulted = false;
    const harness = createHarness({
      afterDurableCommit: async ({ appendWriterPrefix }) => {
        await appendWriterPrefix(ALPHA_ID, "Joined writer: ");
      },
      afterSettlement: async () => {
        if (faulted) return;
        faulted = true;
        throw new Error("injected fault after joined revision settlement");
      },
    });
    const branchId = await harness.seedDestructivePush("oracle-joined-recovery-version");
    await expect(harness.push(branchId)).rejects.toThrow(
      "injected fault after joined revision settlement",
    );
    const [before] = await db.select().from(schema.changeTrailShells);
    expect(before?.version).toBe(2);

    await expirePendingClaims();
    const cold = createHarness();
    await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
    const [after] = await db.select().from(schema.changeTrailShells);
    expect(after?.version).toBe(before?.version);
    harness.destroyWarmState();
    cold.destroyWarmState();
  });

  it("restores a folded-away provisional contribution after a post-cut writer admission", async () => {
    const trailPersistence = createDrizzleChangeTrailAggregateWriter(db);
    let pushId: string | null = null;
    const harness = createHarness({
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

  it("sweep elevation recovers without the safety attribution manifest", async () => {
    const owner = createHarness({
      afterDurableCommit: async () => {
        await db
          .update(schema.documentYjsCheckpoints)
          .set({ attributionManifest: {} })
          .where(eq(schema.documentYjsCheckpoints.documentId, ALPHA_ID));
        throw new Error("death after manifest loss");
      },
    });
    const branchId = await owner.seedDestructivePush("missing-manifest");
    await expect(owner.push(branchId)).rejects.toThrow("death after manifest loss");
    owner.destroyWarmState();
    await expirePendingClaims();
    const cold = createHarness();
    await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
    await expectLiveSweepOnly(cold);
    const observed = await observeSettlement(cold);
    expect(observed.completionState).toMatchObject({ state: "completed" });
    expect(observed.applyResult).toMatchObject({ status: "applied" });
    cold.destroyWarmState();
  });

  it.each([
    ["historical text only", null, false],
    ["this writer's recent edit", USER_ID, true],
    ["another writer's recent edit", OTHER_USER_ID, false],
  ] as const)("classifies the receiving writer for %s", async (_name, recentWriterUserId, swept) => {
    const harness = createHarness();
    const branchId = await harness.seedSweepClassificationPush({
      responseId: `sweep-${_name}`,
      recentWriterUserId,
    });

    await expect(harness.push(branchId)).resolves.toMatchObject({ status: "pushed" });
    expectSweepClassification(harness, swept);
    harness.destroyWarmState();
  });
});
