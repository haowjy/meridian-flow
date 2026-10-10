/** Independent warm/cold rows and observations for PostgreSQL settlement proofs. */

import { splitHashline } from "@meridian/agent-edit";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { expect } from "vitest";
import {
  type createHarness,
  ALPHA_ID as DEFAULT_ALPHA_ID,
  DEFAULT_SCENARIO_IDS,
  resetDatabase,
  schema,
  seedDatabase,
} from "./change-trail-postgres-harness.js";
import type { SettlementOracleOutput } from "./durable-settlement-oracle.js";

export {
  ALPHA_ID,
  BETA_ID,
  closeDatabase,
  createHarness,
  createTestDatabase,
  GAMMA_ID,
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
/** The caller owns hook registration and connection teardown. */
export async function resetSettlementFixture(db: Database): Promise<void> {
  await resetDatabase(db);
  await seedDatabase(db, COLD_SCENARIO_IDS);
}

export async function expirePendingClaims(
  db: Database,
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

/** Lets any recoverer claim every pending settlement at once. */
export async function expireAllPendingClaims(db: Database): Promise<void> {
  await db
    .update(schema.branchPushSettlementOutbox)
    .set({ leaseExpiresAt: new Date(0), availableAt: new Date(0) })
    .where(eq(schema.branchPushSettlementOutbox.state, "pending"));
}

/** Settlement state per document, in document order. */
export async function settlementStates(
  db: Database,
  documentIds: readonly DocumentId[],
): Promise<Array<{ documentId: DocumentId; state: string }>> {
  return db
    .select({
      documentId: schema.branchPushSettlementOutbox.documentId,
      state: schema.branchPushSettlementOutbox.state,
    })
    .from(schema.branchPushSettlementOutbox)
    .where(inArray(schema.branchPushSettlementOutbox.documentId, [...documentIds]))
    .orderBy(asc(schema.branchPushSettlementOutbox.documentId));
}

/** What a settlement may change live: journal, head and projection, per document. */
export async function liveDurableState(db: Database, documentIds: readonly DocumentId[]) {
  return Promise.all(
    documentIds.map(async (documentId) => {
      const updates = await db
        .select({
          id: schema.documentYjsUpdates.id,
          originType: schema.documentYjsUpdates.originType,
        })
        .from(schema.documentYjsUpdates)
        .where(eq(schema.documentYjsUpdates.documentId, documentId))
        .orderBy(asc(schema.documentYjsUpdates.id));
      const [head] = await db
        .select({ latestUpdateSeq: schema.documentYjsHeads.latestUpdateSeq })
        .from(schema.documentYjsHeads)
        .where(eq(schema.documentYjsHeads.documentId, documentId));
      const [row] = await db
        .select({ markdownProjection: schema.documents.markdownProjection })
        .from(schema.documents)
        .where(eq(schema.documents.id, documentId));
      return {
        documentId,
        updates: updates.map(({ originType }) => originType),
        latestUpdateSeq: head?.latestUpdateSeq ?? null,
        markdownProjection: row?.markdownProjection ?? null,
      };
    }),
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
  db: Database,
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
  // Only fixture namespaces differ; retain and check the document-scoped identity.
  for (const change of recoverable) expect(change.beforeBlockIdentity?.documentId).toBe(documentId);
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
