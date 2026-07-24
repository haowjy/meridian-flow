/** PostgreSQL-only warm/cold equivalence proof for branch-push settlement. */
import type { DocumentId } from "@meridian/contracts/runtime";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { PROVENANCE_RESERVED_TYPES } from "./domain/provenance.js";
import {
  ALPHA_ID,
  closeDatabase,
  createHarness,
  db,
  markdownFromUpdate,
  resetDatabase,
  schema,
} from "./test-support/change-trail-postgres-harness.js";
import {
  DurableSettlementOracleMismatch,
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

  it("item 1 F2a: excludes an already-missing gap and reports surviving removed units", async () => {
    const result = await runMatrixOracle("f2a-gap", (harness) =>
      harness.seedMatrixPush({
        responseId: "oracle-f2a-gap",
        initialMarkdown: "abcdefghijklmnopqrstuvwxyz!",
        steps: [
          { source: "writer", markdown: "abcdefghijklmnoqrstuvwxyz!" },
          { source: "agent", markdown: "" },
        ],
      }),
    );

    expect(totalRangeLength(result.cold.eligibleRanges)).toBe(26);
    expect(result.cold.exactBodies).toEqual(["abcdefghijklmnoqrstuvwxyz!"]);
  });

  it.each([
    {
      name: "split",
      initialMarkdown: "alpha bravo charlie delta",
      writerMarkdown: "alpha bravo\n\ncharlie delta",
      expectedBodies: ["alpha bravo", "charlie delta"],
    },
    {
      name: "merge",
      initialMarkdown: "alpha bravo\n\ncharlie delta",
      writerMarkdown: "alpha bravo charlie delta",
      expectedBodies: ["alpha bravo charlie delta"],
    },
  ])("item 2 Gate B $name: real PM re-minted writer ranges report without provenance writes", async ({
    name,
    initialMarkdown,
    writerMarkdown,
    expectedBodies,
  }) => {
    const result = await runMatrixOracle(`gate-b-${name}`, (harness) =>
      harness.seedMatrixPush({
        responseId: `oracle-gate-b-${name}`,
        initialMarkdown,
        steps: [
          { source: "writer", markdown: writerMarkdown },
          { source: "agent", markdown: "" },
        ],
      }),
    );

    expect(result.cold.exactBodies).toEqual(expectedBodies);
    expect(await explicitProvenanceRowCount()).toBe(0);
  });

  it("item 3: split, merge, then partial delete reports exact final visible units", async () => {
    const result = await runMatrixOracle("split-merge-partial", (harness) =>
      harness.seedMatrixPush({
        responseId: "oracle-split-merge-partial",
        initialMarkdown: "one two three four",
        steps: [
          { source: "writer", markdown: "one two\n\nthree four" },
          { source: "writer", markdown: "one two three four" },
          { source: "agent", markdown: "one three four" },
        ],
      }),
    );

    expect(result.cold.exactBodies).toEqual(["one two three four"]);
    expect(totalRangeLength(result.cold.eligibleRanges)).toBe(4);
    expect(result.cold.applyResult).toMatchObject({ markdown: "one three four\n" });
  });

  it("item 4: certified structural carry keeps writer roots for a later deleting push", async () => {
    const result = await runMatrixOracle("certified-structural-carry", async (harness) => {
      const branchId = await harness.seedLiveCertifiedCarry({
        responseId: "oracle-carry-1",
        initialMarkdown: "Opening line.",
        carriedMarkdown: "# Opening line.",
      });
      await harness.stageAnotherDestructiveEdit(branchId);
      return branchId;
    });

    expect(result.cold.exactBodies).toEqual(["# Opening line."]);
    expect(result.cold.applyResult).toMatchObject({ markdown: "#\n" });
  });

  it("item 4: a same-root candidate re-mint is silent", async () => {
    const result = await runMatrixOracle("candidate-certified-carry", (harness) =>
      harness.seedMatrixPush({
        responseId: "oracle-candidate-carry",
        initialMarkdown: "Carried writer root.",
        steps: [
          {
            source: "agent",
            markdown: "Carried writer root.",
            remint: true,
            certifiedCarry: true,
          },
        ],
      }),
    );

    expect(result.cold.exactBodies).toEqual([]);
  });

  it("item 5 F2b: carried writer units report while adjacent fresh agent units stay silent", async () => {
    const removedWriter = await runMatrixOracle("f2b-writer", (harness) =>
      harness.seedMatrixPush({
        responseId: "oracle-f2b-writer",
        initialMarkdown: "Writer protected.",
        steps: [
          { source: "agent", markdown: "Writer protected. Agent fresh." },
          { source: "agent", markdown: "Agent fresh." },
        ],
      }),
    );
    expect(removedWriter.cold.exactBodies).toEqual(["Writer protected."]);

    const removedAgent = await runMatrixOracle("f2b-agent", (harness) =>
      harness.seedMatrixPush({
        responseId: "oracle-f2b-agent",
        initialMarkdown: "Writer protected.",
        steps: [
          { source: "agent", markdown: "Writer protected. Agent fresh." },
          { source: "agent", markdown: "Writer protected." },
        ],
      }),
    );
    expect(removedAgent.cold.trailChanges).toEqual([]);
  }, 15_000);

  it("item 6: blind verbatim-equal candidate replacement still reports", async () => {
    const result = await runMatrixOracle("blind-equal-replacement", (harness) =>
      harness.seedMatrixPush({
        responseId: "oracle-blind-equal-replacement",
        initialMarkdown: "Verbatim writer target.",
        steps: [
          {
            source: "agent",
            markdown: "Verbatim writer target.",
            remint: true,
          },
        ],
      }),
    );

    expect(result.cold.exactBodies).toEqual(["Verbatim writer target."]);
    expect(result.cold.applyResult).toMatchObject({ markdown: "Verbatim writer target.\n" });
  });

  it("item 8: a v3 token follows the original writer root across repeated agent carries", async () => {
    const result = await runMatrixOracle("root-authoritative-token-chain", async (harness) => {
      const branchId = await harness.seedLiveCertifiedCarry({
        responseId: "oracle-root-chain",
        initialMarkdown: "Writer root.",
        carriedMarkdown: ["Writer root.", "Writer root."],
      });
      await harness.stageAnotherDestructiveEdit(branchId);
      return branchId;
    });

    expect(result.cold.exactBodies).toEqual(["Writer root."]);
    expect(totalRangeLength(result.cold.eligibleRanges)).toBe("Writer root.".length);
  });

  it("item 7 true S9: a prior settled fresh replacement makes the later candidate silent", async () => {
    const result = await runMatrixOracle(
      "true-s9",
      async (harness) => {
        const branchId = await harness.seedMatrixPush({
          responseId: "oracle-true-s9",
          initialMarkdown: "Writer ancestry.",
          steps: [{ source: "agent", markdown: "Agent ancestry.", remint: true }],
        });
        await expect(harness.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
        await harness.stageAnotherDestructiveEdit(branchId);
        return branchId;
      },
      2,
    );

    expect(result.cold.exactBodies).toEqual(["Writer ancestry."]);
    expect(result.cold.applyResult).toMatchObject({ markdown: "" });
    expect(await db.select().from(schema.pushLineage)).toHaveLength(2);
  });

  it("item 28 root-unit injectivity: half deletion reports only the deleted half", async () => {
    const result = await runMatrixOracle("root-unit-half-delete", (harness) =>
      harness.seedMatrixPush({
        responseId: "oracle-root-unit-half-delete",
        initialMarkdown: "abcdef",
        steps: [{ source: "agent", markdown: "abc" }],
      }),
    );

    expect(totalRangeLength(result.cold.eligibleRanges)).toBe(3);
    expect(result.cold.exactBodies).toEqual(["abcdef"]);
  });

  it("item 28 divergent replication: authority rejects atomically before settlement", async () => {
    const result = await runMatrixOracle("divergent-restoration", async (harness) => {
      await expect(harness.attemptDivergentReplicationAdmission()).resolves.toEqual({
        rejected: true,
        journaled: false,
        applied: false,
      });
      return harness.seedMatrixPush({
        responseId: "oracle-divergent-restoration",
        initialMarkdown: "Writer remains singular.",
        steps: [{ source: "agent", markdown: "" }],
      });
    });

    expect(result.cold.exactBodies).toEqual(["Writer remains singular."]);
  });

  it("item 18: transient insert-delete state creates no ghost assignment or trail", async () => {
    const result = await runMatrixOracle("transient-insert-delete", (harness) =>
      harness.seedMatrixPush({
        responseId: "oracle-transient-insert-delete",
        initialMarkdown: "Writer visible.",
        steps: [
          {
            source: "agent",
            markdown: "Writer visible.",
            transientInsertDelete: "never visible",
          },
          { source: "agent", markdown: "" },
        ],
      }),
    );

    expect(result.cold.exactBodies).toEqual(["Writer visible."]);
    expect(await explicitProvenanceRowCount()).toBe(0);
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
              code: "authority_busy",
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
              code: "authority_busy",
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

  it("item 23: pending insertion keeps the originating agent birth after its writer parent arrives", async () => {
    const result = await runMatrixOracle("pending-dependency-birth", (harness) =>
      harness.seedPendingDependencyPush(),
    );

    expect(result.cold.exactBodies).toEqual([]);
    expect(result.cold.applyResult).toMatchObject({ markdown: "" });
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

  it("addendum 15/item 24: carry, generation replacement, and Restore retain roots warm and cold", async () => {
    const restored = "Explicit restored writer root.";
    const result = await runMatrixOracle("checkpoint-explicit-restoration", (harness) =>
      harness.seedCheckpointRestoredExplicitDelete("00000000-0000-4000-8000-000000002409"),
    );

    expect(result.cold.exactBodies).toEqual([restored]);
    expect(totalRangeLength(result.cold.eligibleRanges)).toBe(restored.length);
    expect(result.cold.canonicalIdentities).not.toEqual([]);
  });

  it("reports a normalized durable mismatch rather than accepting warm authority", async () => {
    await expect(
      settlementOracle({
        runWarm: async () => emptyOutput("completed"),
        commitColdSubject: async () => {},
        destroyWarmState: async () => {},
        recoverFromPostgres: async () => emptyOutput("pending"),
      }),
    ).rejects.toBeInstanceOf(DurableSettlementOracleMismatch);
  });
});

async function runMatrixOracle(
  id: string,
  seed: (harness: ReturnType<typeof createHarness>) => Promise<string>,
  killAtCommit = 1,
) {
  let coldHarness: ReturnType<typeof createHarness> | undefined;
  let commitCount = 0;
  return settlementOracle({
    async runWarm() {
      await resetDatabase();
      const warm = createHarness();
      const branchId = await seed(warm);
      await expect(warm.autoPush(branchId)).resolves.toMatchObject({ status: "pushed" });
      const observed = await observeSettlement(warm);
      warm.destroyWarmState();
      return observed;
    },
    async commitColdSubject() {
      await resetDatabase();
      coldHarness = createHarness({
        afterDurableCommit: async () => {
          commitCount += 1;
          if (commitCount === killAtCommit) {
            throw new Error(`injected ${id} process death after durable push commit`);
          }
        },
      });
      const branchId = await seed(coldHarness);
      await expect(coldHarness.autoPush(branchId)).rejects.toThrow(`injected ${id} process death`);
    },
    async destroyWarmState() {
      coldHarness?.destroyWarmState();
      coldHarness = undefined;
    },
    async recoverFromPostgres() {
      await db
        .update(schema.branchPushSettlementOutbox)
        .set({ leaseExpiresAt: new Date(0), availableAt: new Date(0) })
        .where(eq(schema.branchPushSettlementOutbox.state, "pending"));
      const cold = createHarness();
      await expect(cold.recoverPendingLiveSettlements()).resolves.toBe(1);
      const observed = await observeSettlement(cold);
      cold.destroyWarmState();
      return observed;
    },
  });
}

function totalRangeLength(ranges: readonly { length: number }[]): number {
  return ranges.reduce((sum, range) => sum + range.length, 0);
}

async function explicitProvenanceRowCount(): Promise<number> {
  const rows = await db.select().from(schema.documentYjsUpdates);
  return rows.filter((row) => {
    const doc = new Y.Doc({ gc: false });
    try {
      Y.applyUpdate(doc, row.updateData);
      return PROVENANCE_RESERVED_TYPES.some((name) => doc.getArray(name).length > 0);
    } finally {
      doc.destroy();
    }
  }).length;
}

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

function emptyOutput(state: string): SettlementOracleOutput {
  return {
    trailChanges: [],
    exactBodies: [],
    canonicalIdentities: [],
    eligibleRanges: [],
    applyResult: "applied",
    completionState: state,
    forwardActions: [],
  };
}
