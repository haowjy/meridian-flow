/** Independent warm/cold rows and observations for PostgreSQL settlement proofs. */

import { splitHashline } from "@meridian/agent-edit";
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { expect } from "vitest";
import { createDrizzlePendingSettlementStore } from "../adapters/drizzle-pending-settlement.js";
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

/** Expires the claims of the pending batches that settle this document. */
export async function expirePendingClaims(
  db: Database,
  documentId: DocumentId = DEFAULT_ALPHA_ID,
): Promise<void> {
  const batches = db
    .select({ batchId: schema.branchPushSettlementOutbox.batchId })
    .from(schema.branchPushSettlementOutbox)
    .where(eq(schema.branchPushSettlementOutbox.documentId, documentId));
  await db
    .update(schema.branchPushSettlementBatches)
    .set(expiredClaim)
    .where(
      and(
        eq(schema.branchPushSettlementBatches.state, "pending"),
        inArray(schema.branchPushSettlementBatches.id, batches),
      ),
    );
}

/** A store for claim and load probes only; completion needs the harness's dependencies. */
export function claimProbeStore(db: Database) {
  return createDrizzlePendingSettlementStore(
    db,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

/**
 * The database, except that the first UPDATE of `table` runs `hook` after it
 * resolves and before its caller continues: a stall right after the UPDATE.
 */
export function stallAfterFirstUpdate(
  db: Database,
  table: unknown,
  hook: () => Promise<void>,
): Database {
  let armed = true;
  const afterResolve = <T extends object>(builder: T): T =>
    new Proxy(builder, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (key === "then" && typeof value === "function") {
          return (resolve: (value: unknown) => void, reject: (cause: unknown) => void) =>
            (target as unknown as PromiseLike<unknown>)
              .then(async (result) => {
                await hook();
                return result;
              })
              .then(resolve, reject);
        }
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const next = value.apply(target, args);
          return next && typeof next === "object" ? afterResolve(next) : next;
        };
      },
    });
  return new Proxy(db, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "update") {
        return (updated: unknown) => {
          const builder = target.update(updated as never);
          if (!armed || updated !== table) return builder;
          armed = false;
          return afterResolve(builder);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Lets any recoverer claim every pending batch at once. */
export async function expireAllPendingClaims(db: Database): Promise<void> {
  await db
    .update(schema.branchPushSettlementBatches)
    .set(expiredClaim)
    .where(eq(schema.branchPushSettlementBatches.state, "pending"));
}

// A released claim has no lease to expire; the claim-shape check keeps it null.
const expiredClaim = {
  leaseExpiresAt: sql`CASE WHEN ${schema.branchPushSettlementBatches.claimToken} IS NULL THEN NULL ELSE to_timestamp(0) END`,
  availableAt: new Date(0),
};

/** Settlement state and batch per document, in document order. */
export async function settlementStates(
  db: Database,
  documentIds: readonly DocumentId[],
): Promise<Array<{ documentId: DocumentId; batchId: string; state: string }>> {
  return db
    .select({
      documentId: schema.branchPushSettlementOutbox.documentId,
      batchId: schema.branchPushSettlementOutbox.batchId,
      state: schema.branchPushSettlementBatches.state,
    })
    .from(schema.branchPushSettlementOutbox)
    .innerJoin(
      schema.branchPushSettlementBatches,
      eq(schema.branchPushSettlementBatches.id, schema.branchPushSettlementOutbox.batchId),
    )
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
  const [batch] = outbox
    ? await db
        .select({ state: schema.branchPushSettlementBatches.state })
        .from(schema.branchPushSettlementBatches)
        .where(eq(schema.branchPushSettlementBatches.id, outbox.batchId))
    : [];
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
      state: batch?.state,
      joinVersion: outbox.joinVersion,
    },
  };
}
