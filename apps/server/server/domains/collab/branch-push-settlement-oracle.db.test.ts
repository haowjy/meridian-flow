/** PostgreSQL cold cut, stale-claim fencing and commit-fault proofs. */

import type { DocumentId } from "@meridian/contracts/runtime";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  appliedMarkdown,
  BETA_ID,
  COLD_SCENARIO_IDS,
  closeDatabase,
  createHarness,
  createTestDatabase,
  expectLiveSweepOnly,
  expireAllPendingClaims,
  expirePendingClaims,
  GAMMA_ID,
  liveDurableState,
  markdownFromUpdate,
  observeSettlement,
  resetSettlementFixture,
  schema,
  settlementStates,
} from "./test-support/branch-push-settlement-fixture.js";
import { settlementOracle } from "./test-support/durable-settlement-oracle.js";

const BATCH = [ALPHA_ID, BETA_ID, GAMMA_ID] as const;

describe("durable branch-push settlement oracle (postgres)", () => {
  const db = createTestDatabase();
  beforeEach(() => resetSettlementFixture(db));
  afterAll(() => closeDatabase(db));

  async function seedBatch(harness: ReturnType<typeof createHarness>): Promise<string[]> {
    const branchIds: string[] = [];
    for (const documentId of BATCH) {
      branchIds.push(await harness.seedDestructivePush(`batch-${documentId}`, documentId));
    }
    return branchIds;
  }

  it("settles a batch in one completion transaction; warm rooms see it only after commit", async () => {
    let harness!: ReturnType<typeof createHarness>;
    let broadcastsBefore = 0;
    const roomsDuringAdmission: string[][] = [];
    harness = createHarness(db, {
      afterAdmission() {
        roomsDuringAdmission.push(harness.liveRoomBroadcasts().slice(broadcastsBefore));
      },
    });
    const branchIds = await seedBatch(harness);
    broadcastsBefore = harness.liveRoomBroadcasts().length;

    const result = await harness.pushBranches(branchIds);

    expect(result.items.map((item) => item.status)).toEqual(["pushed", "pushed", "pushed"]);
    expect(roomsDuringAdmission).toEqual([[], [], []]);
    expect(new Set(harness.liveRoomBroadcasts().slice(broadcastsBefore))).toEqual(new Set(BATCH));
    for (const documentId of BATCH) {
      await expect(harness.liveMarkdown(documentId)).resolves.toBe("Survivor.\n");
    }
    harness.destroyWarmState();
  });

  it.each([
    "after the durable batch commit",
    "after the second admission",
  ] as const)("a batch that fails %s leaves live untouched; one of two recoverers settles it whole", async (fault) => {
    const failing = createHarness(db, {
      ...(fault === "after the durable batch commit"
        ? {
            afterDurableCommit: async () => {
              throw new Error("injected process death after the batch commit");
            },
          }
        : {
            afterAdmission: ({ ordinal }: { ordinal: number }) => {
              if (ordinal === 2) throw new Error("injected failure after the second admission");
            },
          }),
    });
    const branchIds = await seedBatch(failing);
    const liveBefore = await liveDurableState(db, BATCH);
    const markdownBefore = await Promise.all(BATCH.map((id) => failing.liveMarkdown(id)));
    const broadcastsBefore = failing.liveRoomBroadcasts().length;

    await expect(failing.pushBranches(branchIds)).rejects.toThrow("injected");

    expect(await liveDurableState(db, BATCH)).toEqual(liveBefore);
    expect(failing.liveRoomBroadcasts().slice(broadcastsBefore)).toEqual([]);
    await expect(Promise.all(BATCH.map((id) => failing.liveMarkdown(id)))).resolves.toEqual(
      markdownBefore,
    );
    expect((await settlementStates(db, BATCH)).map(({ state }) => state)).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    failing.destroyWarmState();

    await expireAllPendingClaims(db);
    const recoverers = [createHarness(db), createHarness(db)];
    const recovered = await Promise.all(
      recoverers.map((recoverer) => recoverer.recoverPendingLiveSettlements()),
    );

    expect([...recovered].sort()).toEqual([0, 1]);
    expect((await settlementStates(db, BATCH)).map(({ state }) => state)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);
    const settled = await liveDurableState(db, BATCH);
    for (const [index, document] of settled.entries()) {
      const before = liveBefore[index] as (typeof liveBefore)[number];
      expect(document.updates.slice(before.updates.length).at(-1)).toBe("reconcile");
      expect(document.updates.filter((origin) => origin === "reconcile")).toHaveLength(1);
    }
    for (const recoverer of recoverers) recoverer.destroyWarmState();
    const reader = createHarness(db);
    for (const documentId of BATCH) {
      await expect(reader.liveMarkdown(documentId)).resolves.toBe("Survivor.\n");
    }
    reader.destroyWarmState();
  });

  it("item 6: stale A cannot renew, record failure, or perform the first apply after B claims", async () => {
    const actorA = createHarness(db, {
      afterDurableCommit: async () => {
        throw new Error("pause actor A after durable claim");
      },
    });
    const branchId = await actorA.seedDestructivePush("item-6-stale-owner");
    await expect(actorA.push(branchId)).rejects.toThrow("pause actor A");
    const [ownedByA] = await db.select().from(schema.branchPushSettlementBatches);
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
    const contender = createHarness(db);
    await expect(contender.recoverPendingLiveSettlements()).resolves.toBe(0);
    contender.destroyWarmState();
    await expirePendingClaims(db);

    let staleProbe:
      | Awaited<ReturnType<ReturnType<typeof createHarness>["probeStaleSettlementClaim"]>>
      | undefined;
    let actorB!: ReturnType<typeof createHarness>;
    actorB = createHarness(db, {
      async afterClassification() {
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
    expect(await db.select().from(schema.branchPushSettlementBatches)).toEqual([
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
        const warm = createHarness(db, {
          afterDurableCommit: injectPostCutWriter,
          afterClassification: deleteAfterFirstClassification(),
        });
        const branchId = await warm.seedDestructivePush("oracle-f1a-warm");
        await expect(warm.push(branchId)).resolves.toMatchObject({ status: "pushed" });
        await expectLiveSweepOnly(warm);
        const observed = await observeSettlement(db, warm);
        warm.destroyWarmState();
        return observed;
      },
      async commitColdSubject() {
        coldHarness = createHarness(db, {
          ids: COLD_SCENARIO_IDS,
          afterDurableCommit: async (input) => {
            await injectPostCutWriter(input);
            throw new Error("injected process death after durable push commit");
          },
        });
        const branchId = await coldHarness.seedDestructivePush("oracle-f1a-cold");
        await expect(coldHarness.push(branchId)).rejects.toThrow("injected process death");
      },
      async destroyWarmState() {
        coldHarness?.destroyWarmState();
        coldHarness = undefined;
      },
      async recoverFromPostgres() {
        await expirePendingClaims(db, COLD_SCENARIO_IDS.ALPHA_ID);
        const cold = createHarness(db, {
          ids: COLD_SCENARIO_IDS,
          afterClassification: deleteAfterFirstClassification(),
        });
        await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
        await expectLiveSweepOnly(cold);
        const observed = await observeSettlement(db, cold, COLD_SCENARIO_IDS.ALPHA_ID);
        cold.destroyWarmState();
        return observed;
      },
    });

    expect(result.cold.exactBodies).toEqual([
      expect.stringContaining("Writer recent: Writer captured body."),
    ]);
    expect(appliedMarkdown(result.cold)).toBe("Survivor.\n");
    expect(result.cold.completionState).toEqual({ state: "completed", joinVersion: 2 });
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
        warm = createHarness(db, {
          afterDurableCommit: async ({ appendWriterPrefix }) => {
            await expect(warm.attemptSnapshotReplacement()).resolves.toEqual({
              ok: false,
              code: "authority_head_busy",
            });
            await appendWriterPrefix(ALPHA_ID, "Racing writer: ");
          },
        });
        const branchId = await warm.seedDestructivePush("oracle-race-fault-warm");
        await expect(warm.push(branchId)).resolves.toMatchObject({ status: "pushed" });
        const observed = await observeSettlement(db, warm);
        warm.destroyWarmState();
        return observed;
      },
      async commitColdSubject() {
        coldHarness = createHarness(db, {
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
        await expect(coldHarness.push(branchId)).rejects.toThrow("fault after journal commit");
      },
      async destroyWarmState() {
        coldHarness?.destroyWarmState();
        coldHarness = undefined;
      },
      async recoverFromPostgres() {
        await expirePendingClaims(db, COLD_SCENARIO_IDS.ALPHA_ID);
        const failingCompletion = createHarness(db, {
          ids: COLD_SCENARIO_IDS,
          beforeCompletionCommit() {
            throw new Error("completion transaction failed after live apply");
          },
        });
        await expect(failingCompletion.recoverPendingLiveSettlements()).resolves.toBe(0);
        await expect(settlementStates(db, [COLD_SCENARIO_IDS.ALPHA_ID])).resolves.toEqual([
          expect.objectContaining({ state: "pending" }),
        ]);
        // The rolled-back completion never reached the warm room.
        await expect(failingCompletion.liveMarkdown(COLD_SCENARIO_IDS.ALPHA_ID)).resolves.toContain(
          "Writer captured body.",
        );
        failingCompletion.destroyWarmState();
        await expirePendingClaims(db, COLD_SCENARIO_IDS.ALPHA_ID);
        const cold = createHarness(db, { ids: COLD_SCENARIO_IDS });
        await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
        const observed = await observeSettlement(db, cold, COLD_SCENARIO_IDS.ALPHA_ID);
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
