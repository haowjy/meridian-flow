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
  afterAll(closeDatabase);

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

  it("item 9: prose admitted after the response causal cut receives no observation credit", async () => {
    const result = await runMatrixOracle("post-observation-admission", (harness) =>
      harness.seedObservedCertifiedDelete({
        responseId: "00000000-0000-4000-8000-000000000901",
        initialMarkdown: "Equal rendering.",
        observation: { cut: "head", coverage: "current" },
        postObservationMarkdown: "Equal rendering.",
      }),
    );

    expect(result.cold.exactBodies).toEqual(["Equal rendering."]);
    expect(totalRangeLength(result.cold.eligibleRanges)).toBe("Equal rendering.".length);
  });

  it.each([
    {
      name: "both conjuncts",
      responseId: "00000000-0000-4000-8000-000000002701",
      observation: { cut: "head" as const, coverage: "current" as const },
      reports: false,
    },
    {
      name: "coverage without inclusion",
      responseId: "00000000-0000-4000-8000-000000002702",
      observation: { cut: "empty" as const, coverage: "current" as const },
      reports: true,
    },
    {
      name: "inclusion without coverage",
      responseId: "00000000-0000-4000-8000-000000002703",
      observation: { cut: "head" as const, coverage: "none" as const },
      reports: true,
    },
  ])("item 27 $name: equal rendering requires causal inclusion and coverage", async ({
    name,
    responseId,
    observation,
    reports,
  }) => {
    const result = await runMatrixOracle(`equal-rendering-${name}`, (harness) =>
      harness.seedObservedCertifiedDelete({
        responseId,
        initialMarkdown: "Observed writer prose.",
        observation,
      }),
    );

    expect(result.cold.exactBodies).toEqual(reports ? ["Observed writer prose."] : []);
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
    causalMembership: [],
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
    causalMembership: [],
    eligibleRanges: [],
    applyResult: "applied",
    completionState: state,
    forwardActions: [],
  };
}
