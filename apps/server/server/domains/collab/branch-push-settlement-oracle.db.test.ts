/** PostgreSQL cold cut, stale-claim fencing and commit-fault proofs. */

import type { DocumentId } from "@meridian/contracts/runtime";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  appliedMarkdown,
  COLD_SCENARIO_IDS,
  createHarness,
  db,
  expectLiveSweepOnly,
  expirePendingClaims,
  markdownFromUpdate,
  observeSettlement,
  schema,
  setupSettlementFixture,
} from "./test-support/branch-push-settlement-fixture.js";
import { settlementOracle } from "./test-support/durable-settlement-oracle.js";

setupSettlementFixture();
describe("durable branch-push settlement oracle (postgres)", () => {
  it("item 6: stale A cannot renew, record failure, or perform the first apply after B claims", async () => {
    const actorA = createHarness({
      afterDurableCommit: async () => {
        throw new Error("pause actor A after durable claim");
      },
    });
    const branchId = await actorA.seedDestructivePush("item-6-stale-owner");
    await expect(actorA.autoPush(branchId)).rejects.toThrow("pause actor A");
    const [ownedByA] = await db.select().from(schema.branchPushSettlementOutbox);
    if (
      !ownedByA?.claimToken ||
      !ownedByA.claimKind ||
      !ownedByA.leaseExpiresAt ||
      !ownedByA.claimedAt
    ) {
      throw new Error("actor A claim was not persisted");
    }
    const staleClaim = {
      token: ownedByA.claimToken,
      epoch: Number(ownedByA.claimEpoch),
      kind: ownedByA.claimKind,
      leaseExpiresAt: ownedByA.leaseExpiresAt,
    };
    actorA.destroyWarmState();
    const contender = createHarness();
    await expect(contender.recoverPendingLiveSettlements()).resolves.toBe(0);
    contender.destroyWarmState();
    await expirePendingClaims();

    let staleProbe:
      | Awaited<ReturnType<ReturnType<typeof createHarness>["probeStaleSettlementClaim"]>>
      | undefined;
    let actorB!: ReturnType<typeof createHarness>;
    actorB = createHarness({
      async afterSettlement() {
        staleProbe ??= await actorB.probeStaleSettlementClaim(staleClaim);
      },
    });
    await expect(actorB.recoverPendingLiveSettlements()).resolves.toBe(1);
    expect(staleProbe).toEqual({
      renewed: null,
      failureRecorded: false,
      completion: "retry",
      completionCallbackRan: false,
    });
    expect(await db.select().from(schema.branchPushSettlementOutbox)).toEqual([
      expect.objectContaining({ state: "completed", claimToken: null }),
    ]);
    expect(actorB.liveRoomBroadcasts()).not.toEqual([]);
    actorB.destroyWarmState();
  });

  it("F1a: preserves the true lock cut while joining post-cut writer updates after a killed process", async () => {
    let coldHarness: ReturnType<typeof createHarness> | undefined;
    const injectPostCutWriter = async (input: {
      documentIds: readonly DocumentId[];
      appendWriterPrefix(documentId: DocumentId, prefix: string): Promise<void>;
    }) => {
      expect(input.documentIds).toHaveLength(1);
      await input.appendWriterPrefix(input.documentIds[0]!, "Writer post-cut: ");
    };

    const deleteAfterFirstClassification = () => {
      let joined = false;
      return async ({
        documentId,
        deleteWriterPrefix,
      }: {
        documentId: DocumentId;
        deleteWriterPrefix(documentId: DocumentId, length: number): Promise<void>;
      }) => {
        if (joined) return;
        joined = true;
        await deleteWriterPrefix(documentId, 1);
      };
    };
    const result = await settlementOracle({
      async runWarm() {
        const warm = createHarness({
          afterDurableCommit: injectPostCutWriter,
          afterSettlement: deleteAfterFirstClassification(),
        });
        const branchId = await warm.seedDestructivePush("oracle-f1a-warm");
        await expect(warm.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
        await expectLiveSweepOnly(warm);
        const observed = await observeSettlement(warm);
        warm.destroyWarmState();
        return observed;
      },
      async commitColdSubject() {
        coldHarness = createHarness({
          ids: COLD_SCENARIO_IDS,
          afterDurableCommit: async (input) => {
            await injectPostCutWriter(input);
            throw new Error("injected process death after durable push commit");
          },
        });
        const branchId = await coldHarness.seedDestructivePush("oracle-f1a-cold");
        await expect(coldHarness.autoPush(branchId)).rejects.toThrow("injected process death");
      },
      async destroyWarmState() {
        coldHarness?.destroyWarmState();
        coldHarness = undefined;
      },
      async recoverFromPostgres() {
        await expirePendingClaims(COLD_SCENARIO_IDS.ALPHA_ID);
        const cold = createHarness({
          ids: COLD_SCENARIO_IDS,
          afterSettlement: deleteAfterFirstClassification(),
        });
        await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
        await expectLiveSweepOnly(cold);
        const observed = await observeSettlement(cold, COLD_SCENARIO_IDS.ALPHA_ID);
        cold.destroyWarmState();
        return observed;
      },
    });

    expect(result.cold.exactBodies).toEqual([
      expect.stringContaining("Writer recent: Writer captured body."),
    ]);
    expect(appliedMarkdown(result.cold)).toBe("Survivor.\n");
    expect(result.cold.completionState).toEqual({
      state: "completed",
      joinVersion: 2,
      settledJoinVersion: 2,
    });
    const [completed] = await db
      .select()
      .from(schema.branchPushSettlementOutbox)
      .where(eq(schema.branchPushSettlementOutbox.documentId, COLD_SCENARIO_IDS.ALPHA_ID));
    const postCut = await db
      .select()
      .from(schema.branchPushOutboxUpdates)
      .where(eq(schema.branchPushOutboxUpdates.pushId, completed?.pushId));
    expect(markdownFromUpdate(completed?.lockCutUpdate ?? new Uint8Array())).toContain(
      "Writer recent: Writer captured body.",
    );
    expect(markdownFromUpdate(completed?.lockCutUpdate ?? new Uint8Array())).not.toContain(
      "Writer post-cut:",
    );
    expect(postCut).toHaveLength(2);
    expect(postCut).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceKind: "journal", update: expect.any(Uint8Array) }),
      ]),
    );
  });

  it("item 13: unresolved settlement joins survive a commit fault and block snapshot replacement", async () => {
    let warm: ReturnType<typeof createHarness>;
    let coldHarness: ReturnType<typeof createHarness> | undefined;
    const result = await settlementOracle({
      async runWarm() {
        warm = createHarness({
          afterDurableCommit: async ({ appendWriterPrefix }) => {
            await expect(warm.attemptSnapshotReplacement()).resolves.toEqual({
              ok: false,
              code: "authority_head_busy",
            });
            await appendWriterPrefix(ALPHA_ID, "Racing writer: ");
          },
        });
        const branchId = await warm.seedDestructivePush("oracle-race-fault-warm");
        await expect(warm.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
        const observed = await observeSettlement(warm);
        warm.destroyWarmState();
        return observed;
      },
      async commitColdSubject() {
        coldHarness = createHarness({
          ids: COLD_SCENARIO_IDS,
          afterDurableCommit: async ({ appendWriterPrefix }) => {
            await expect(coldHarness?.attemptSnapshotReplacement()).resolves.toEqual({
              ok: false,
              code: "authority_head_busy",
            });
            await appendWriterPrefix(COLD_SCENARIO_IDS.ALPHA_ID, "Racing writer: ");
            throw new Error("fault after journal commit and settlement staging");
          },
        });
        const branchId = await coldHarness.seedDestructivePush("oracle-race-fault-cold");
        await expect(coldHarness.autoPush(branchId)).rejects.toThrow("fault after journal commit");
      },
      async destroyWarmState() {
        coldHarness?.destroyWarmState();
        coldHarness = undefined;
      },
      async recoverFromPostgres() {
        await expirePendingClaims(COLD_SCENARIO_IDS.ALPHA_ID);
        const failingCompletion = createHarness({
          ids: COLD_SCENARIO_IDS,
          afterLiveApply() {
            throw new Error("completion transaction failed after live apply");
          },
        });
        await expect(failingCompletion.recoverPendingLiveSettlements()).resolves.toBe(0);
        const [pending] = await db
          .select()
          .from(schema.branchPushSettlementOutbox)
          .where(eq(schema.branchPushSettlementOutbox.documentId, COLD_SCENARIO_IDS.ALPHA_ID));
        expect(pending).toMatchObject({ state: "pending", settledJoinVersion: 1 });
        await expect(failingCompletion.liveMarkdown(COLD_SCENARIO_IDS.ALPHA_ID)).resolves.toBe(
          "Survivor.\n",
        );
        failingCompletion.destroyWarmState();
        await db
          .update(schema.branchPushSettlementOutbox)
          .set({ availableAt: new Date(0) })
          .where(eq(schema.branchPushSettlementOutbox.documentId, COLD_SCENARIO_IDS.ALPHA_ID));
        const cold = createHarness({ ids: COLD_SCENARIO_IDS });
        await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
        const observed = await observeSettlement(cold, COLD_SCENARIO_IDS.ALPHA_ID);
        cold.destroyWarmState();
        return observed;
      },
    });

    expect(result.cold.exactBodies).toEqual([
      expect.stringContaining("Writer recent: Writer captured body."),
    ]);
    expect(appliedMarkdown(result.cold)).toBe("Survivor.\n");
  });
});
