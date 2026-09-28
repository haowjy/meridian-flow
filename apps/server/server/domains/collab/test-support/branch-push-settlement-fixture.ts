/** Independent warm/cold rows and observations for PostgreSQL settlement proofs. */

import { splitHashline } from "@meridian/agent-edit";
import type { DocumentId } from "@meridian/contracts/runtime";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeEach, expect } from "vitest";
import {
  closeDatabase,
  type createHarness,
  ALPHA_ID as DEFAULT_ALPHA_ID,
  DEFAULT_SCENARIO_IDS,
  db,
  resetDatabase,
  schema,
  seedDatabase,
} from "./change-trail-postgres-harness.js";
import type { SettlementOracleOutput } from "./durable-settlement-oracle.js";

export {
  ALPHA_ID,
  createHarness,
  db,
  markdownFromUpdate,
  OTHER_USER_ID,
  runInRootDrizzleTransaction,
  schema,
  USER_ID,
} from "./change-trail-postgres-harness.js";

// Keep the document suffix stable: the fixture's deterministic Yjs client IDs use it.
export const COLD_SCENARIO_IDS = Object.fromEntries(
  Object.entries(DEFAULT_SCENARIO_IDS).map(([key, value]) => [key, value.replace("4000", "4001")]),
) as typeof DEFAULT_SCENARIO_IDS;
export function setupSettlementFixture() {
  beforeEach(async () => {
    await resetDatabase();
    await seedDatabase(COLD_SCENARIO_IDS);
  });
  afterAll(closeDatabase);
}

export async function expirePendingClaims(
  documentId: DocumentId = DEFAULT_ALPHA_ID,
): Promise<void> {
  await db
    .update(schema.branchPushSettlementOutbox)
    .set({ leaseExpiresAt: new Date(0), availableAt: new Date(0) })
    .where(
      and(
        eq(schema.branchPushSettlementOutbox.state, "pending"),
        eq(schema.branchPushSettlementOutbox.documentId, documentId),
      ),
    );
}

export function appliedMarkdown(output: SettlementOracleOutput): string {
  const result = output.applyResult;
  if (
    typeof result !== "object" ||
    result === null ||
    !("markdown" in result) ||
    typeof result.markdown !== "string"
  ) {
    throw new Error("settlement apply result has no markdown");
  }
  return result.markdown;
}

export async function expectLiveSweepOnly(
  harness: ReturnType<typeof createHarness>,
): Promise<void> {
  expect(harness.changeEvents()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        changes: expect.arrayContaining([expect.objectContaining({ swept: true })]),
      }),
    ]),
  );
  const trail = await harness.trailRowMembership();
  for (const detail of trail.details) {
    for (const change of detail.changes as unknown as Array<Record<string, unknown>>) {
      expect(change).not.toHaveProperty("swept");
      expect(change).not.toHaveProperty("writerImpact");
      expect(change).not.toHaveProperty("writerProtection");
    }
  }
}

export function expectSweepClassification(
  harness: ReturnType<typeof createHarness>,
  swept: boolean,
): void {
  expect(harness.changeEvents()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        changes: expect.arrayContaining([expect.objectContaining({ swept })]),
      }),
    ]),
  );
}

export async function observeSettlement(
  harness: ReturnType<typeof createHarness>,
  documentId: DocumentId = DEFAULT_ALPHA_ID,
): Promise<SettlementOracleOutput> {
  const trail = await harness.trailRowMembership();
  type ReceiptChange = {
    kind: unknown;
    beforeText: string | null;
    beforeBlockIdentity: { documentId: string; clientID: number; clock: number } | null;
  };
  const changes = trail.details
    .filter((detail) => detail.documentId === documentId)
    .flatMap((detail) => detail.changes as unknown as ReceiptChange[]);
  const recoverable = changes.filter(
    (change) => change.beforeText !== null && change.beforeBlockIdentity,
  );
  const [outbox] = await db
    .select()
    .from(schema.branchPushSettlementOutbox)
    .where(eq(schema.branchPushSettlementOutbox.documentId, documentId))
    .orderBy(desc(schema.branchPushSettlementOutbox.pushId))
    .limit(1);
  const [push] = await db
    .select()
    .from(schema.pushLineage)
    .where(eq(schema.pushLineage.documentId, documentId))
    .orderBy(desc(schema.pushLineage.id))
    .limit(1);
  if (!outbox || !push) throw new Error("settlement durable output is unavailable");
  return {
    trailChanges: recoverable.map((change) => ({
      kind: change.kind,
      beforeText: change.beforeText,
      beforeBlockIdentity: change.beforeBlockIdentity && {
        ...change.beforeBlockIdentity,
        documentId: DEFAULT_ALPHA_ID,
      },
    })),
    exactBodies: recoverable.map((change) => {
      const beforeText = change.beforeText as string;
      return splitHashline(beforeText)?.body ?? beforeText;
    }),
    canonicalIdentities: recoverable.map(
      (change) =>
        ({ ...change.beforeBlockIdentity, documentId: DEFAULT_ALPHA_ID }) as {
          documentId: string;
          clientID: number;
          clock: number;
        },
    ),
    eligibleRanges: [],
    applyResult: {
      status: push.upstreamUpdateSeq === null ? "not_applied" : "applied",
      markdown: await harness.liveMarkdown(documentId),
    },
    completionState: {
      state: outbox.state,
      joinVersion: outbox.joinVersion,
      settledJoinVersion: outbox.settledJoinVersion,
    },
  };
}
