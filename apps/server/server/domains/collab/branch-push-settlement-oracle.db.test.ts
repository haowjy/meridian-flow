/** PostgreSQL settlement oracle: one batch settled end to end, cold cut, stale-claim fencing and commit-fault proofs. */

import type { DocumentId } from "@meridian/contracts/runtime";
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ALPHA_ID,
  appliedMarkdown,
  SETTLEMENT_BATCH as BATCH,
  BETA_ID,
  COLD_SCENARIO_IDS,
  claimProbeStore,
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
  runInRootDrizzleTransaction,
  schema,
  seedSettlementBatch as seedBatch,
  settlementStates,
  stallAfterFirstUpdate,
} from "./test-support/branch-push-settlement-fixture.js";
import { settlementOracle } from "./test-support/durable-settlement-oracle.js";

describe("durable branch-push settlement oracle (postgres)", () => {
  const db = createTestDatabase();
  beforeEach(() => resetSettlementFixture(db));
  afterAll(() => closeDatabase(db));

  it("settles a batch in one root-owned transaction; warm rooms, then ordered effects, then every drained branch reset", async () => {
    let harness!: ReturnType<typeof createHarness>;
    let broadcastsBefore = 0;
    const roomsDuringAdmission: string[][] = [];
    const effects: string[] = [];
    let competingWrite: (() => Promise<void>) | undefined;
    // Attempt 1: a writer reaches beta (not the first member) after its drain, so the
    // batch retries before anything admits. Attempt 2: the lease expires after the first
    // admission, so the whole attempt rolls back. Attempt 3 settles.
    let attempts = 0;
    let lateWriter = true;
    let expireAfterAdmission = false;
    harness = createHarness(db, {
      async afterClassification({ documentId }) {
        if (documentId === ALPHA_ID) attempts += 1;
        if (documentId === BETA_ID && lateWriter) {
          lateWriter = false;
          expireAfterAdmission = true;
          await harness.appendWriterPrefix(BETA_ID, "Writer late: ");
          // The writer's own edit reached its room; settlement's must wait for commit.
          broadcastsBefore = harness.liveRoomBroadcasts().length;
        }
      },
      async afterAdmission() {
        roomsDuringAdmission.push(harness.liveRoomBroadcasts().slice(broadcastsBefore));
        if (attempts === 2 && expireAfterAdmission) {
          expireAfterAdmission = false;
          await harness.expireLeaseInTransaction();
        }
      },
      // Another process writes the second member's draft after the batch staged it.
      afterDurableCommit: async () => competingWrite?.(),
      publicationSteps: [
        {
          kind: "test_first_effect",
          async plan() {
            return {
              async afterCommit() {
                const rooms = new Set(harness.liveRoomBroadcasts().slice(broadcastsBefore));
                effects.push(`step 1 started with ${rooms.size} warm rooms`);
                await new Promise((resolve) => setTimeout(resolve, 20));
                effects.push("step 1 failed");
                throw new Error("injected after-commit failure");
              },
            };
          },
        },
        {
          kind: "test_second_effect",
          async plan() {
            return {
              afterCommit() {
                effects.push("step 2 ran");
              },
            };
          },
        },
      ],
    });
    const [alpha, beta, gamma] = (await seedBatch(harness)) as [string, string, string];
    // Request order is not document order; items answer in request order.
    const request = [gamma, alpha, beta];
    const generations = await Promise.all(request.map((id) => harness.branchGeneration(id)));
    broadcastsBefore = harness.liveRoomBroadcasts().length;

    await expect(
      runInRootDrizzleTransaction(db, () => harness.pushBranches(request, "auto")),
    ).rejects.toThrow(/root-owned/);
    expect(await db.select().from(schema.pushLineage)).toEqual([]);

    const competitor = createHarness(db);
    competingWrite = async () => {
      competingWrite = undefined;
      await competitor.stageAnotherDestructiveEdit(beta);
    };
    const result = await harness.pushBranches(request, "auto");

    expect(result.items).toEqual(
      [GAMMA_ID, ALPHA_ID, BETA_ID].map((documentId, index) =>
        expect.objectContaining({
          status: "pushed",
          push: expect.objectContaining({ branchId: request[index], documentId }),
        }),
      ),
    );
    expect(attempts).toBe(3);
    // Three admissions in attempt 2, which the expiry rolled back, and three in attempt 3:
    // no warm room changed before commit, and nothing admitted twice.
    expect(roomsDuringAdmission).toEqual([[], [], [], [], [], []]);
    for (const document of await liveDurableState(db, BATCH)) {
      expect(document.updates.filter((origin) => origin === "reconcile")).toHaveLength(1);
    }
    const betaJoins = await db
      .select({ sourceKind: schema.branchPushOutboxUpdates.sourceKind })
      .from(schema.branchPushOutboxUpdates)
      .innerJoin(
        schema.branchPushSettlementOutbox,
        eq(schema.branchPushSettlementOutbox.pushId, schema.branchPushOutboxUpdates.pushId),
      )
      .where(eq(schema.branchPushSettlementOutbox.documentId, BETA_ID));
    expect(betaJoins.map(({ sourceKind }) => sourceKind)).toContain("journal");
    expect(new Set(harness.liveRoomBroadcasts().slice(broadcastsBefore))).toEqual(new Set(BATCH));
    expect(effects).toEqual(["step 1 started with 3 warm rooms", "step 1 failed", "step 2 ran"]);
    for (const documentId of BATCH) {
      await expect(harness.liveMarkdown(documentId)).resolves.toBe("Survivor.\n");
    }
    // Every drained branch is rebased onto live; the competed one keeps its new row.
    expect(result.items.map((item) => ("branchReset" in item ? item.branchReset : null))).toEqual([
      { branchId: gamma, fromGeneration: generations[0] },
      { branchId: alpha, fromGeneration: generations[1] },
      null,
    ]);
    expect(await Promise.all(request.map((id) => harness.branchGeneration(id)))).toEqual([
      (generations[0] as number) + 1,
      (generations[1] as number) + 1,
      generations[2],
    ]);
    for (const branchId of [gamma, alpha]) {
      const [branch] = await db
        .select({ state: schema.documentBranches.state })
        .from(schema.documentBranches)
        .where(eq(schema.documentBranches.id, branchId));
      expect(markdownFromUpdate(branch?.state ?? new Uint8Array())).toBe("Survivor.\n");
    }
    const betaRows = await db
      .select({ status: schema.branchWriteJournal.status })
      .from(schema.branchWriteJournal)
      .where(eq(schema.branchWriteJournal.branchId, beta));
    expect(betaRows.filter(({ status }) => status === "active")).toHaveLength(1);
    competitor.destroyWarmState();
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
    await expect(
      runInRootDrizzleTransaction(db, () => recoverers[0]!.recoverPendingLiveSettlements()),
    ).rejects.toThrow(/root-owned/);
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

  it("item 6: no stale or stalled claimant keeps, adopts or reuses ownership", async () => {
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

    // A claimant that stalls between its claim UPDATE and its read never adopts its successor.
    const batchId = ownedByA.id;
    const rival = claimProbeStore(db);
    const rivalToken = "00000000-0000-4000-8000-000000000e04";
    let rivalClaim: Awaited<ReturnType<typeof rival.claimRecoverableBatch>> = null;
    await expirePendingClaims(db);
    const stalled = claimProbeStore(
      stallAfterFirstUpdate(db, schema.branchPushSettlementBatches, async () => {
        await expirePendingClaims(db);
        rivalClaim = await rival.claimRecoverableBatch({ batchId, token: rivalToken });
      }),
    );
    await expect(
      stalled.claimRecoverableBatch({ batchId, token: "00000000-0000-4000-8000-000000000e03" }),
    ).resolves.toBeNull();
    const heldByRival = (rivalClaim as Awaited<ReturnType<typeof rival.claimRecoverableBatch>>)
      ?.claim;
    if (!heldByRival) throw new Error("the rival did not claim the batch");
    // The same token reclaiming after backoff is a new owner: its old epoch is stale.
    await expect(
      rival.recordFailure({ batchId, claim: heldByRival, error: "backoff" }),
    ).resolves.toBe(true);
    await expirePendingClaims(db);
    const reclaimed = await rival.claimRecoverableBatch({ batchId, token: rivalToken });
    expect(reclaimed?.claim).toMatchObject({ token: rivalToken, epoch: heldByRival.epoch + 1 });
    await expect(rival.loadSettlementBatch({ batchId, owner: heldByRival })).resolves.toBeNull();
    await expect(rival.renewClaim({ batchId, claim: heldByRival })).resolves.toBeNull();
    await expirePendingClaims(db);

    let ambientCompletion: string | undefined;
    let staleProbe:
      | Awaited<ReturnType<ReturnType<typeof createHarness>["probeStaleSettlementClaim"]>>
      | undefined;
    let actorB!: ReturnType<typeof createHarness>;
    actorB = createHarness(db, {
      async afterClassification() {
        staleProbe ??= await actorB.probeStaleSettlementClaim(staleClaim);
        ambientCompletion ??= await actorB.attemptAmbientCompletion();
      },
    });
    await expect(actorB.recoverPendingLiveSettlements()).resolves.toBe(1);
    expect(staleProbe).toEqual({
      renewed: null,
      failureRecorded: false,
      completion: "retry",
      completionCallbackRan: false,
      afterCommitRan: false,
      liveRowsUnchanged: true,
    });
    // Completion itself, not only staging and recovery, refuses to join an ambient transaction.
    expect(ambientCompletion).toMatch(/root-owned/);
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
