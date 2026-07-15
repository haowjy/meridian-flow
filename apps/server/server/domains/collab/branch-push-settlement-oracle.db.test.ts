/** PostgreSQL-only warm/cold equivalence proof for branch-push settlement. */
import type { DocumentId } from "@meridian/contracts/runtime";
import { afterAll, describe, expect, it } from "vitest";
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
