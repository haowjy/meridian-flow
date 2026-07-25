/** PostgreSQL-only warm/cold equivalence proof for branch-push settlement. */
import type { DocumentId } from "@meridian/contracts/runtime";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createDrizzleChangeTrailPersistence } from "./adapters/drizzle-change-trails.js";
import type { TrailChangeV1 } from "./domain/trail-read-kernel.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  db,
  markdownFromUpdate,
  resetDatabase,
  runInRootDrizzleTransaction,
  schema,
} from "./test-support/change-trail-postgres-harness.js";
import {
  type SettlementOracleOutput,
  settlementOracle,
} from "./test-support/durable-settlement-oracle.js";

const enabled = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
if (!enabled || !process.env.DATABASE_URL) {
  throw new Error("DB suites require RUN_DB_TESTS=1 and DATABASE_URL");
}

describe("durable branch-push settlement oracle (postgres)", () => {
  afterAll(async () => {
    await resetDatabase();
    await closeDatabase();
  });

  it("item 1: an awaited preparation fault cannot let queued mutations cross the durable boundary", async () => {
    await resetDatabase();
    let entered!: () => void;
    let release!: () => void;
    const preparationEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const preparationRelease = new Promise<void>((resolve) => {
      release = resolve;
    });
    let actorA!: ReturnType<typeof createHarness>;
    let writerCrossed = false;
    let queuedWriter: Promise<void> | undefined;
    actorA = createHarness({
      async duringAwaitedPreparation() {
        entered();
        queuedWriter = actorA.addLiveDependency().then(() => {
          writerCrossed = true;
        });
        await preparationRelease;
        throw new Error("injected awaited-preparation fault");
      },
    });
    const branchId = await actorA.seedDestructivePush("item-1-awaited-preparation");
    const pushA = actorA.autoPush(branchId);
    await preparationEntered;

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(writerCrossed).toBe(false);
    expect(await db.select().from(schema.pushLineage)).toEqual([]);
    expect(await db.select().from(schema.branchPushSettlementOutbox)).toEqual([]);

    release();
    await expect(pushA).rejects.toThrow("awaited-preparation fault");
    await queuedWriter;
    expect(await actorA.liveMarkdown(ALPHA_ID)).toContain("Writer follow-up:");
    expect(await db.select().from(schema.pushLineage)).toEqual([]);
    actorA.destroyWarmState();
  });

  it("item 3: A/B/C ordering retries a post-classification join in one timeline", async () => {
    await resetDatabase();
    const actorA = createHarness({
      afterDurableCommit: async () => {
        throw new Error("injected actor A death");
      },
    });
    const branchId = await actorA.seedDestructivePush("item-3-three-party");
    await expect(actorA.autoPush(branchId)).rejects.toThrow("actor A death");
    actorA.destroyWarmState();

    // C-before-B is durable before B claims, so it is part of B's first classification.
    const actorC = createHarness();
    await actorC.addLiveDependency();
    actorC.destroyWarmState();
    await expirePendingClaims();

    let postClassificationJoin = 0;
    const actorB = createHarness({
      async afterSettlement({ documentId, deleteWriterPrefix }) {
        if (postClassificationJoin++ === 0) await deleteWriterPrefix(documentId, 1);
      },
    });
    await expect(actorB.recoverPendingLiveSettlements()).resolves.toBe(1);
    const [settled] = await db.select().from(schema.branchPushSettlementOutbox);
    expect(postClassificationJoin).toBeGreaterThanOrEqual(1);
    expect(settled).toMatchObject({
      state: "completed",
      joinVersion: 2,
      settledJoinVersion: 2,
    });
    expect(await actorB.liveMarkdown(ALPHA_ID)).not.toContain("Writer captured body.");
    actorB.destroyWarmState();
  });

  it("item 6: stale A cannot renew, record failure, or perform the first apply after B claims", async () => {
    await resetDatabase();
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

  it("F1a: preserves the true lock cut and trails post-cut writer prose after a killed process", async () => {
    let coldHarness: ReturnType<typeof createHarness> | undefined;
    const injectPostCutWriter = async (input: {
      documentIds: readonly DocumentId[];
      appendWriterPrefix(documentId: DocumentId, prefix: string): Promise<void>;
    }) => {
      expect(input.documentIds).toEqual([ALPHA_ID]);
      await input.appendWriterPrefix(ALPHA_ID, "Writer post-cut: ");
    };

    const result = await settlementOracle({
      async runWarm() {
        await resetDatabase();
        const warm = createHarness({ afterDurableCommit: injectPostCutWriter });
        const branchId = await warm.seedDestructivePush("oracle-f1a-warm");
        await expect(warm.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
        const observed = await observeSettlement(warm);
        warm.destroyWarmState();
        return observed;
      },
      async commitColdSubject() {
        await resetDatabase();
        coldHarness = createHarness({
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
        await db
          .update(schema.branchPushSettlementOutbox)
          .set({ leaseExpiresAt: new Date(0), availableAt: new Date(0) });
        const cold = createHarness();
        await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
        const observed = await observeSettlement(cold);
        cold.destroyWarmState();
        return observed;
      },
    });

    expect(result.cold.exactBodies).toEqual([
      expect.stringContaining("Writer post-cut: Writer recent: Writer captured body."),
    ]);
    expect(result.cold.completionState).toEqual({
      state: "completed",
      joinVersion: 1,
      settledJoinVersion: 1,
    });
    const [completed] = await db.select().from(schema.branchPushSettlementOutbox);
    const postCut = await db.select().from(schema.branchPushOutboxUpdates);
    expect(markdownFromUpdate(completed?.lockCutUpdate ?? new Uint8Array())).toContain(
      "Writer recent: Writer captured body.",
    );
    expect(markdownFromUpdate(completed?.lockCutUpdate ?? new Uint8Array())).not.toContain(
      "Writer post-cut:",
    );
    expect(postCut).toEqual([
      expect.objectContaining({ sourceKind: "journal", update: expect.any(Uint8Array) }),
    ]);
  });

  it("F1b and fencing: a live lease denies a contender and only the replacement claim completes", async () => {
    let warmReplacement: ReturnType<typeof createHarness> | undefined;
    let coldHarness: ReturnType<typeof createHarness> | undefined;
    const result = await settlementOracle({
      async runWarm() {
        await resetDatabase();
        const warm = createHarness({
          afterDurableCommit: async ({ appendWriterPrefix }) => {
            const denied = createHarness();
            await expect(denied.recoverPendingLiveSettlements()).resolves.toBe(0);
            denied.destroyWarmState();
            await appendWriterPrefix(ALPHA_ID, "Fenced writer: ");
            await expirePendingClaims();
            warmReplacement = createHarness();
            await expect(warmReplacement.recoverPendingLiveSettlements()).resolves.toBe(1);
          },
        });
        const branchId = await warm.seedDestructivePush("oracle-f1b-fencing-warm");
        await expect(warm.autoPush(branchId)).rejects.toThrow();
        if (!warmReplacement) throw new Error("replacement settlement did not run");
        const observed = await observeSettlement(warmReplacement);
        warm.destroyWarmState();
        warmReplacement.destroyWarmState();
        warmReplacement = undefined;
        return observed;
      },
      async commitColdSubject() {
        await resetDatabase();
        coldHarness = createHarness({
          afterDurableCommit: async ({ appendWriterPrefix }) => {
            const denied = createHarness();
            await expect(denied.recoverPendingLiveSettlements()).resolves.toBe(0);
            denied.destroyWarmState();
            await appendWriterPrefix(ALPHA_ID, "Fenced writer: ");
            throw new Error("injected fenced-owner process death");
          },
        });
        const branchId = await coldHarness.seedDestructivePush("oracle-f1b-fencing-cold");
        await expect(coldHarness.autoPush(branchId)).rejects.toThrow("fenced-owner process death");
      },
      async destroyWarmState() {
        coldHarness?.destroyWarmState();
        coldHarness = undefined;
      },
      async recoverFromPostgres() {
        await expirePendingClaims();
        const replacement = createHarness();
        await expect(replacement.recoverPendingLiveSettlements()).resolves.toBe(1);
        const observed = await observeSettlement(replacement);
        replacement.destroyWarmState();
        return observed;
      },
    });

    expect(result.cold.exactBodies).toEqual([
      expect.stringContaining("Fenced writer: Writer recent: Writer captured body."),
    ]);
    expect(result.cold.completionState).toMatchObject({ state: "completed" });
  });

  it("handoff: relinquishing the warm claim makes all earlier appends immediately recoverable", async () => {
    let warm: ReturnType<typeof createHarness>;
    let warmReplacement: ReturnType<typeof createHarness> | undefined;
    let coldHarness: ReturnType<typeof createHarness> | undefined;
    const result = await settlementOracle({
      async runWarm() {
        await resetDatabase();
        warm = createHarness({
          afterDurableCommit: async ({ appendWriterPrefix }) => {
            await appendWriterPrefix(ALPHA_ID, "Handed-off writer: ");
            await expect(warm.handoffPendingSettlement()).resolves.toBe(true);
            warmReplacement = createHarness();
            await expect(warmReplacement.recoverPendingLiveSettlements()).resolves.toBe(1);
          },
        });
        const branchId = await warm.seedDestructivePush("oracle-handoff-warm");
        await expect(warm.autoPush(branchId)).rejects.toThrow();
        if (!warmReplacement) throw new Error("handoff replacement did not run");
        const observed = await observeSettlement(warmReplacement);
        warm.destroyWarmState();
        warmReplacement.destroyWarmState();
        warmReplacement = undefined;
        return observed;
      },
      async commitColdSubject() {
        await resetDatabase();
        coldHarness = createHarness({
          afterDurableCommit: async ({ appendWriterPrefix }) => {
            await appendWriterPrefix(ALPHA_ID, "Handed-off writer: ");
            await expect(coldHarness?.handoffPendingSettlement()).resolves.toBe(true);
            throw new Error("injected death after settlement handoff");
          },
        });
        const branchId = await coldHarness.seedDestructivePush("oracle-handoff-cold");
        await expect(coldHarness.autoPush(branchId)).rejects.toThrow(
          "death after settlement handoff",
        );
      },
      async destroyWarmState() {
        coldHarness?.destroyWarmState();
        coldHarness = undefined;
      },
      async recoverFromPostgres() {
        const replacement = createHarness();
        await expect(replacement.recoverPendingLiveSettlements()).resolves.toBe(1);
        const observed = await observeSettlement(replacement);
        replacement.destroyWarmState();
        return observed;
      },
    });

    expect(result.cold.exactBodies).toEqual([
      expect.stringContaining("Handed-off writer: Writer recent: Writer captured body."),
    ]);
  });

  it("delete-only recheck: equal state vectors do not hide a joined writer deletion", async () => {
    let coldHarness: ReturnType<typeof createHarness> | undefined;
    const injectDeleteOnly = async (input: {
      deleteWriterPrefix(documentId: DocumentId, length: number): Promise<void>;
    }) => input.deleteWriterPrefix(ALPHA_ID, "Writer recent: ".length);
    const result = await settlementOracle({
      async runWarm() {
        await resetDatabase();
        const warm = createHarness({ afterDurableCommit: injectDeleteOnly });
        const branchId = await warm.seedDestructivePush("oracle-delete-only-warm");
        await expect(warm.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
        const observed = await observeSettlement(warm);
        warm.destroyWarmState();
        return observed;
      },
      async commitColdSubject() {
        await resetDatabase();
        coldHarness = createHarness({
          afterDurableCommit: async (input) => {
            await injectDeleteOnly(input);
            throw new Error("injected death after delete-only join");
          },
        });
        const branchId = await coldHarness.seedDestructivePush("oracle-delete-only-cold");
        await expect(coldHarness.autoPush(branchId)).rejects.toThrow("delete-only join");
      },
      async destroyWarmState() {
        coldHarness?.destroyWarmState();
        coldHarness = undefined;
      },
      async recoverFromPostgres() {
        await expirePendingClaims();
        const cold = createHarness();
        await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
        const observed = await observeSettlement(cold);
        cold.destroyWarmState();
        return observed;
      },
    });

    expect(result.cold.exactBodies).toEqual([expect.stringContaining("Writer captured body.")]);
    expect(result.cold.exactBodies[0]).not.toContain("Writer recent:");
  });

  it("delete-only post-classification retry: full-state mismatch reclassifies the joined deletion", async () => {
    let warmClassifications = 0;
    let coldClassifications = 0;
    const run = (mode: "warm" | "cold") => {
      let deleted = false;
      return createHarness({
        afterSettlement: async ({ documentId, deleteWriterPrefix, stateVector }) => {
          if (mode === "warm") warmClassifications += 1;
          else coldClassifications += 1;
          if (deleted) {
            if (mode === "cold") throw new Error("injected death after delete reclassification");
            return;
          }
          deleted = true;
          const before = stateVector(documentId);
          await deleteWriterPrefix(documentId, "Writer recent: ".length);
          expect(stateVector(documentId)).toEqual(before);
        },
      });
    };
    let coldHarness: ReturnType<typeof createHarness> | undefined;
    const result = await settlementOracle({
      async runWarm() {
        await resetDatabase();
        const warm = run("warm");
        const branchId = await warm.seedDestructivePush("oracle-delete-retry-warm");
        await expect(warm.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
        const observed = await observeSettlement(warm);
        warm.destroyWarmState();
        return observed;
      },
      async commitColdSubject() {
        await resetDatabase();
        coldHarness = run("cold");
        const branchId = await coldHarness.seedDestructivePush("oracle-delete-retry-cold");
        await expect(coldHarness.autoPush(branchId)).rejects.toThrow(
          "death after delete reclassification",
        );
      },
      async destroyWarmState() {
        coldHarness?.destroyWarmState();
        coldHarness = undefined;
      },
      async recoverFromPostgres() {
        await expirePendingClaims();
        const cold = createHarness();
        await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
        const observed = await observeSettlement(cold);
        cold.destroyWarmState();
        return observed;
      },
    });

    expect(warmClassifications).toBe(2);
    expect(coldClassifications).toBe(2);
    expect(result.cold.exactBodies).toEqual([expect.stringContaining("Writer captured body.")]);
    expect(result.cold.exactBodies[0]).not.toContain("Writer recent:");
  });

  it("item 13: unresolved settlement joins survive a commit fault and block snapshot replacement", async () => {
    let warm: ReturnType<typeof createHarness>;
    let coldHarness: ReturnType<typeof createHarness> | undefined;
    const result = await settlementOracle({
      async runWarm() {
        await resetDatabase();
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
        await resetDatabase();
        coldHarness = createHarness({
          afterDurableCommit: async ({ appendWriterPrefix }) => {
            await expect(coldHarness?.attemptSnapshotReplacement()).resolves.toEqual({
              ok: false,
              code: "authority_head_busy",
            });
            await appendWriterPrefix(ALPHA_ID, "Racing writer: ");
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
        await expirePendingClaims();
        const cold = createHarness();
        await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
        const observed = await observeSettlement(cold);
        cold.destroyWarmState();
        return observed;
      },
    });

    expect(result.cold.exactBodies).toEqual([
      expect.stringContaining("Racing writer: Writer recent: Writer captured body."),
    ]);
  });

  it.each([
    { boundary: "settle and complete", hook: "afterSettlement" as const },
    { boundary: "live apply and transaction settle", hook: "afterLiveApply" as const },
  ])("item 13: a fault between $boundary recovers identically warm and cold", async ({ hook }) => {
    let coldHarness: ReturnType<typeof createHarness> | undefined;
    const faultingHarness = () => {
      let faulted = false;
      const failOnce = () => {
        if (faulted) return;
        faulted = true;
        throw new Error(`injected ${hook} fault`);
      };
      return createHarness(
        hook === "afterSettlement"
          ? { afterSettlement: async () => failOnce() }
          : { afterLiveApply: failOnce },
      );
    };
    const result = await settlementOracle({
      async runWarm() {
        await resetDatabase();
        const warm = faultingHarness();
        const branchId = await warm.seedDestructivePush(`oracle-${hook}-warm`);
        await expect(warm.autoPush(branchId)).rejects.toThrow(`injected ${hook} fault`);
        await expirePendingClaims();
        await expect(warm.recoverPendingLiveSettlements()).resolves.toBe(1);
        const observed = await observeSettlement(warm);
        warm.destroyWarmState();
        return observed;
      },
      async commitColdSubject() {
        await resetDatabase();
        coldHarness = faultingHarness();
        const branchId = await coldHarness.seedDestructivePush(`oracle-${hook}-cold`);
        await expect(coldHarness.autoPush(branchId)).rejects.toThrow(`injected ${hook} fault`);
      },
      async destroyWarmState() {
        coldHarness?.destroyWarmState();
        coldHarness = undefined;
      },
      async recoverFromPostgres() {
        await expirePendingClaims();
        const cold = createHarness();
        await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
        const observed = await observeSettlement(cold);
        cold.destroyWarmState();
        return observed;
      },
    });

    expect(result.cold.completionState).toMatchObject({ state: "completed" });
  });

  it("recovery refines the trail version already classified for the same joined revision", async () => {
    await resetDatabase();
    let faulted = false;
    const harness = createHarness({
      afterDurableCommit: async ({ appendWriterPrefix }) => {
        await appendWriterPrefix(ALPHA_ID, "Joined writer: ");
      },
      afterSettlement: async () => {
        if (faulted) return;
        faulted = true;
        throw new Error("injected fault after joined revision classification");
      },
    });
    const branchId = await harness.seedDestructivePush("oracle-joined-recovery-version");
    await expect(harness.autoPush(branchId)).rejects.toThrow(
      "injected fault after joined revision classification",
    );
    const [before] = await db.select().from(schema.changeTrailShells);
    expect(before?.version).toBe(2);

    await expirePendingClaims();
    const cold = createHarness();
    await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
    const [after] = await db.select().from(schema.changeTrailShells);
    expect(after?.version).toBe(before?.version);
  });

  it("restores a folded-away provisional contribution after a post-cut writer admission", async () => {
    await resetDatabase();
    const trailPersistence = createDrizzleChangeTrailPersistence(db);
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
            swept: null,
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
                  swept: 0,
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

    await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });

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

  it("item 24: a checkpoint without its attribution manifest blocks instead of guessing", async () => {
    let coldHarness: ReturnType<typeof createHarness> | undefined;
    const removeManifest = async () => {
      await db.update(schema.documentYjsCheckpoints).set({ attributionManifest: {} });
    };
    const result = await settlementOracle({
      async runWarm() {
        await resetDatabase();
        const warm = createHarness({ afterDurableCommit: removeManifest });
        const branchId = await warm.seedDestructivePush("oracle-missing-manifest-warm");
        await expect(warm.autoPush(branchId)).rejects.toThrow("attribution manifest");
        const observed = await observeSettlement(warm);
        warm.destroyWarmState();
        return observed;
      },
      async commitColdSubject() {
        await resetDatabase();
        coldHarness = createHarness({
          afterDurableCommit: async () => {
            await removeManifest();
            throw new Error("injected death after manifest loss");
          },
        });
        const branchId = await coldHarness.seedDestructivePush("oracle-missing-manifest-cold");
        await expect(coldHarness.autoPush(branchId)).rejects.toThrow("manifest loss");
      },
      async destroyWarmState() {
        coldHarness?.destroyWarmState();
        coldHarness = undefined;
      },
      async recoverFromPostgres() {
        await expirePendingClaims();
        const cold = createHarness();
        await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(0);
        const observed = await observeSettlement(cold);
        cold.destroyWarmState();
        return observed;
      },
    });

    expect(result.cold.completionState).toMatchObject({ state: "blocked" });
    expect(result.cold.applyResult).toMatchObject({ status: "not_applied" });
  });
});

async function expirePendingClaims(): Promise<void> {
  await db
    .update(schema.branchPushSettlementOutbox)
    .set({ leaseExpiresAt: new Date(0), availableAt: new Date(0) })
    .where(eq(schema.branchPushSettlementOutbox.state, "pending"));
}

async function observeSettlement(
  harness: ReturnType<typeof createHarness>,
): Promise<SettlementOracleOutput> {
  const trail = await harness.trailRows();
  type SweptChange = {
    kind: unknown;
    beforeText: unknown;
    beforeBlockIdentity: { documentId: string; clientID: number; clock: number };
    writerProtection: {
      kind: string;
      body: { markdown: string };
      ranges: Array<{ clientID: number; clock: number; length: number }>;
    };
    forwardAction?: unknown;
  };
  const changes = trail.details.flatMap((detail) => detail.changes as unknown as SweptChange[]);
  const swept = changes.filter((change) => change.writerProtection?.kind === "sweep");
  const [outbox] = await db.select().from(schema.branchPushSettlementOutbox);
  const [push] = await db.select().from(schema.pushLineage);
  if (!outbox || !push) throw new Error("settlement durable output is unavailable");
  return {
    trailChanges: swept.map((change) => ({
      kind: change.kind,
      beforeText: change.beforeText,
      beforeBlockIdentity: change.beforeBlockIdentity,
      writerProtection: change.writerProtection,
    })),
    exactBodies: swept.map((change) => change.writerProtection.body.markdown as string),
    canonicalIdentities: swept.map((change) => change.beforeBlockIdentity),
    eligibleRanges: swept.flatMap((change) => change.writerProtection.ranges),
    applyResult: {
      status: push.upstreamUpdateSeq === null ? "not_applied" : "applied",
      markdown: await harness.liveMarkdown(ALPHA_ID),
    },
    completionState: {
      state: outbox.state,
      joinVersion: outbox.joinVersion,
      settledJoinVersion: outbox.settledJoinVersion,
    },
    forwardActions: swept.flatMap((change) =>
      change.forwardAction === undefined ? [] : [change.forwardAction],
    ),
  };
}
