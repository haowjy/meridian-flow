import { randomUUID } from "node:crypto";
/** Drizzle store for durable branch pushes into the live Yjs journal. */
import type { ThreadId, TurnId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branchWriteJournal,
  documentBranches,
  pushLineage,
  works,
} from "@meridian/database/schema";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { currentDrizzleDb, runInDrizzleTransaction } from "../../../shared/drizzle-transaction.js";
import type { NoticePort } from "../../notices/index.js";
import {
  type BranchJournalRow,
  BranchPushCommitConflictError,
  type BranchPushStore,
  type PreparedDiscardCommit,
  type PreparedPushCommit,
  type PushLineageRow,
} from "../domain/branch-push-contracts.js";
import { persistDurableTrailRecord } from "../domain/branch-trail-projection.js";
import type { ChangeTrailPersistence } from "../domain/ports/change-trail-persistence.js";
import { lockDocumentMutation } from "./drizzle-document-mutation-lock.js";
import type { StagePendingSettlementWithinTx } from "./drizzle-pending-settlement.js";

/** Global lock order for multi-document push batches — matches journal appendBatch. */
export function sortPushesByDocumentId<T extends { branch: { documentId: string } }>(
  pushes: readonly T[],
): T[] {
  return [...pushes].sort((left, right) =>
    left.branch.documentId.localeCompare(right.branch.documentId),
  );
}

async function persistRequiredTrail(
  persistence: ChangeTrailPersistence | undefined,
  prepared: PreparedPushCommit,
  push: PushLineageRow,
  notices?: NoticePort,
): Promise<void> {
  if (!persistence) throw new Error("Branch push committer requires change-trail persistence");
  await persistDurableTrailRecord(prepared.trail, push, persistence, notices);
}

export function createDrizzleBranchPushStore(
  db: Database,
  stagePendingSettlementWithinTx: StagePendingSettlementWithinTx,
  changeTrails?: ChangeTrailPersistence,
  notices?: NoticePort,
): BranchPushStore {
  return {
    async listActiveJournalRows(branchId, generation) {
      const rows = await db
        .select()
        .from(branchWriteJournal)
        .where(
          and(
            eq(branchWriteJournal.branchId, branchId),
            eq(branchWriteJournal.generation, generation),
            eq(branchWriteJournal.status, "active"),
          ),
        )
        .orderBy(branchWriteJournal.id);
      return rows.map(mapJournalRow);
    },

    async listReviewableJournalRows(branchId, generation) {
      const rows = await db
        .select()
        .from(branchWriteJournal)
        .where(
          and(
            eq(branchWriteJournal.branchId, branchId),
            eq(branchWriteJournal.generation, generation),
            inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
          ),
        )
        .orderBy(branchWriteJournal.id);
      return rows.map(mapJournalRow);
    },

    async listJournalRowsForTurn(input) {
      const conditions = [
        eq(branchWriteJournal.threadId, input.threadId),
        eq(branchWriteJournal.turnId, input.turnId),
      ];
      if (input.branchId) conditions.push(eq(branchWriteJournal.branchId, input.branchId));
      if (input.generation !== undefined) {
        conditions.push(eq(branchWriteJournal.generation, input.generation));
      }
      if (input.statuses && input.statuses.length > 0) {
        conditions.push(inArray(branchWriteJournal.status, [...input.statuses]));
      }
      const rows = await db
        .select()
        .from(branchWriteJournal)
        .where(and(...conditions))
        .orderBy(branchWriteJournal.id);
      return rows.map(mapJournalRow);
    },

    async listJournalRowsForBranch(input) {
      const conditions = [
        eq(branchWriteJournal.branchId, input.branchId),
        eq(branchWriteJournal.generation, input.generation),
      ];
      if (input.throughJournalId !== undefined) {
        conditions.push(sql`${branchWriteJournal.id} <= ${input.throughJournalId}`);
      }
      const rows = await db
        .select()
        .from(branchWriteJournal)
        .where(and(...conditions))
        .orderBy(branchWriteJournal.id);
      return rows.map(mapJournalRow);
    },

    async listPushLineageForTurn(input) {
      const turnRows = await db
        .select({ id: branchWriteJournal.id })
        .from(branchWriteJournal)
        .where(
          and(
            eq(branchWriteJournal.threadId, input.threadId),
            eq(branchWriteJournal.turnId, input.turnId),
          ),
        );
      const journalIds = turnRows.map((row) => row.id);
      const directCondition = and(
        eq(pushLineage.threadId, input.threadId),
        eq(pushLineage.turnId, input.turnId),
      );
      const rows = await db
        .select()
        .from(pushLineage)
        .where(
          journalIds.length > 0
            ? sql`(${pushLineage.threadId} = ${input.threadId} AND ${pushLineage.turnId} = ${input.turnId}) OR ${pushLineage.journalIds} && ARRAY[${sql.join(journalIds, sql`, `)}]::bigint[]`
            : directCondition,
        )
        .orderBy(pushLineage.id);
      return rows.map(mapLineage);
    },

    async listConcurrentJournalRows(branchId, generation, options) {
      const floor = options.afterJournalId ?? 0;
      const rows = await db
        .select({ row: branchWriteJournal })
        .from(branchWriteJournal)
        .innerJoin(documentBranches, eq(branchWriteJournal.branchId, documentBranches.id))
        .where(
          and(
            eq(documentBranches.documentId, options.documentId),
            sql`${branchWriteJournal.id} > ${floor}`,
            // Same-branch active rows and cross-branch pushed rows are both needed for
            // attribution. Cold-start scans are deliberately unbounded until we add a
            // push-ordered floor; max(journal.id) is unsound because journal ids can include
            // unpushed sibling rows and do not encode push order. Each row remains bounded
            // by its owning branch generation so reset/future-generation rows cannot leak
            // backward.
            sql`(
              (${branchWriteJournal.branchId} = ${branchId}
                AND ${branchWriteJournal.generation} <= ${generation}
                AND ${branchWriteJournal.status} IN ('active', 'pushed'))
              OR (${branchWriteJournal.branchId} <> ${branchId}
                AND ${branchWriteJournal.generation} <= ${documentBranches.generation}
                AND ${branchWriteJournal.status} = 'pushed')
            )`,
          ),
        )
        .orderBy(branchWriteJournal.id);
      return rows.map(({ row }) => mapJournalRow(row));
    },

    async latestPushForBranch(branchId, generation) {
      const [row] = await db
        .select()
        .from(pushLineage)
        .where(
          and(
            eq(pushLineage.branchId, branchId),
            sql`${pushLineage.receiptPayload}->>'branchGeneration' = ${String(generation)}`,
          ),
        )
        .orderBy(sql`${pushLineage.id} DESC`)
        .limit(1);
      return row ? mapLineage(row) : null;
    },

    async listPushesForDocument(documentId) {
      const rows = await db
        .select()
        .from(pushLineage)
        .where(eq(pushLineage.documentId, documentId))
        .orderBy(desc(pushLineage.id));
      return rows.map(mapLineage);
    },

    async commitPush(input) {
      return runInDrizzleTransaction(db, async () => {
        const txDb = currentDrizzleDb(db);
        const existing = await findLineage(txDb, input.idempotencyKey);
        if (existing) return { status: "conflict" as const, push: existing };
        const now = new Date();
        const lineage = await commitPreparedPush(txDb, input, now);
        const push = mapLineage(lineage);
        await persistRequiredTrail(changeTrails, input, push, notices);
        await stagePendingSettlementWithinTx(txDb, input, push);
        return {
          status: "inserted" as const,
          push,
        };
      });
    },

    async commitDiscard(input) {
      return runInDrizzleTransaction(db, async () => {
        await commitPreparedDiscard(currentDrizzleDb(db), input, new Date());
      });
    },

    async commitTurnRedo(input) {
      return runInDrizzleTransaction(db, async () => {
        await commitPreparedRedo(currentDrizzleDb(db), input, new Date());
        if (!changeTrails)
          throw new Error("Branch push committer requires change-trail persistence");
        await changeTrails.reopenOwners(trailOwnersForRows(input.journalRows));
      });
    },

    async commitPushBatch(input) {
      return runInDrizzleTransaction(db, async () => {
        const txDb = currentDrizzleDb(db);
        const pushes = sortPushesByDocumentId(input.pushes);
        for (const push of pushes) {
          const existing = await findLineage(txDb, push.idempotencyKey);
          if (existing) throw new BranchPushCommitConflictError(push.branch.branchId);
        }
        const now = new Date();
        const rows = [];
        for (const push of pushes) {
          const lineage = await commitPreparedPush(txDb, push, now);
          rows.push(lineage);
          const mapped = mapLineage(lineage);
          await persistRequiredTrail(changeTrails, push, mapped, notices);
          await stagePendingSettlementWithinTx(txDb, push, mapped);
        }
        const mappedPushes = rows.map(mapLineage);
        return {
          pushes: mappedPushes,
        };
      });
    },

    async countUnpushedRowsForWork(workId) {
      const [{ count } = { count: 0 }] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(branchWriteJournal)
        .innerJoin(documentBranches, eq(branchWriteJournal.branchId, documentBranches.id))
        .where(
          and(
            eq(documentBranches.workId, workId),
            eq(documentBranches.kind, "work_draft"),
            eq(documentBranches.status, "active"),
            eq(branchWriteJournal.generation, documentBranches.generation),
            eq(branchWriteJournal.status, "active"),
          ),
        );
      return count;
    },

    async listActiveWorkDraftBranchIdsForWork(workId) {
      const rows = await db
        .select({ id: documentBranches.id })
        .from(documentBranches)
        .where(
          and(
            eq(documentBranches.workId, workId),
            eq(documentBranches.kind, "work_draft"),
            eq(documentBranches.status, "active"),
          ),
        );
      return rows.map((row) => row.id);
    },

    async updateWorkDraftPushPolicy(workId, policy) {
      await runInDrizzleTransaction(db, async () => {
        await currentDrizzleDb(db)
          .update(documentBranches)
          .set({ pushPolicy: policy, updatedAt: new Date() })
          .where(
            and(
              eq(documentBranches.workId, workId),
              eq(documentBranches.kind, "work_draft"),
              eq(documentBranches.status, "active"),
            ),
          );
        await currentDrizzleDb(db)
          .update(works)
          .set({ aiWriteMode: aiWriteModeProjection(policy), updatedAt: new Date() })
          .where(eq(works.id, workId));
      });
    },

    async markRollbackPending(input) {
      const rows = await db
        .update(branchWriteJournal)
        .set({ status: "rollback_pending" })
        .where(
          and(
            eq(branchWriteJournal.branchId, input.branchId),
            eq(branchWriteJournal.threadId, input.threadId),
            eq(branchWriteJournal.turnId, input.turnId),
            eq(branchWriteJournal.generation, input.generation),
            eq(branchWriteJournal.status, "active"),
          ),
        )
        .returning({ id: branchWriteJournal.id });
      return rows.length;
    },
  };
}

async function commitPreparedDiscard(
  db: DrizzleDb,
  input: PreparedDiscardCommit,
  now: Date,
): Promise<void> {
  const [casRow] = await db
    .update(documentBranches)
    .set({
      state: Buffer.from(input.state),
      stateVector: Buffer.from(input.stateVector),
      updatedAt: now,
    })
    .where(
      and(
        eq(documentBranches.id, input.branch.branchId),
        eq(documentBranches.status, "active"),
        eq(documentBranches.generation, input.branch.generation),
        eq(documentBranches.state, Buffer.from(input.branch.state)),
      ),
    )
    .returning({ id: documentBranches.id });
  if (!casRow) throw new BranchPushCommitConflictError(input.branch.branchId);

  const discardedRows = await db
    .update(branchWriteJournal)
    .set({
      status: "discarded",
      reviewedBy: input.reviewedByUserId ?? null,
      reviewedAt: now,
    })
    .where(
      and(
        eq(branchWriteJournal.branchId, input.branch.branchId),
        eq(branchWriteJournal.generation, input.branch.generation),
        inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
        inArray(
          branchWriteJournal.id,
          input.journalRows.map((row) => row.id),
        ),
      ),
    )
    .returning({ id: branchWriteJournal.id });
  if (discardedRows.length !== input.journalRows.length) {
    throw new BranchPushCommitConflictError(input.branch.branchId);
  }
}

async function commitPreparedRedo(
  db: DrizzleDb,
  input: PreparedDiscardCommit,
  now: Date,
): Promise<void> {
  const [casRow] = await db
    .update(documentBranches)
    .set({
      state: Buffer.from(input.state),
      stateVector: Buffer.from(input.stateVector),
      updatedAt: now,
    })
    .where(
      and(
        eq(documentBranches.id, input.branch.branchId),
        eq(documentBranches.status, "active"),
        eq(documentBranches.generation, input.branch.generation),
        eq(documentBranches.state, Buffer.from(input.branch.state)),
      ),
    )
    .returning({ id: documentBranches.id });
  if (!casRow) throw new BranchPushCommitConflictError(input.branch.branchId);

  let restoredCount = 0;
  for (const row of input.journalRows) {
    const replacement = input.replacementUpdateDataByJournalId?.get(row.id);
    const [restored] = await db
      .update(branchWriteJournal)
      .set({
        status: "active",
        ...(replacement
          ? { updateData: Buffer.from(replacement) }
          : input.replacementUpdateData
            ? { updateData: Buffer.from(input.replacementUpdateData) }
            : {}),
        reviewedBy: input.reviewedByUserId ?? null,
        reviewedAt: now,
      })
      .where(
        and(
          eq(branchWriteJournal.branchId, input.branch.branchId),
          eq(branchWriteJournal.generation, input.branch.generation),
          eq(branchWriteJournal.status, "discarded"),
          eq(branchWriteJournal.id, row.id),
        ),
      )
      .returning({ id: branchWriteJournal.id });
    if (restored) restoredCount += 1;
  }
  if (restoredCount !== input.journalRows.length) {
    throw new BranchPushCommitConflictError(input.branch.branchId);
  }
}

function trailOwnersForRows(
  rows: PreparedDiscardCommit["journalRows"],
): Array<
  | { kind: "shared"; threadId: string; turnId: null }
  | { kind: "turn"; threadId: string; turnId: string }
> {
  const owners = new Map<
    string,
    | { kind: "shared"; threadId: string; turnId: null }
    | { kind: "turn"; threadId: string; turnId: string }
  >();
  for (const row of rows) {
    if (!row.threadId || !row.turnId) continue;
    owners.set(`shared:${row.threadId}`, { kind: "shared", threadId: row.threadId, turnId: null });
    owners.set(`turn:${row.threadId}:${row.turnId}`, {
      kind: "turn",
      threadId: row.threadId,
      turnId: row.turnId,
    });
  }
  return [...owners.values()];
}

async function findLineage(db: DrizzleDb, idempotencyKey: string): Promise<PushLineageRow | null> {
  const [row] = await db
    .select()
    .from(pushLineage)
    .where(eq(pushLineage.idempotencyKey, idempotencyKey))
    .limit(1);
  return row ? mapLineage(row) : null;
}

async function commitPreparedPush(
  db: DrizzleDb,
  input: PreparedPushCommit,
  now: Date,
): Promise<typeof pushLineage.$inferSelect> {
  await lockDocumentMutation(db, input.branch.documentId);

  const [casRow] = await db
    .update(documentBranches)
    .set({ updatedAt: sql`${documentBranches.updatedAt}` })
    .where(
      and(
        eq(documentBranches.id, input.branch.branchId),
        eq(documentBranches.status, "active"),
        eq(documentBranches.generation, input.branch.generation),
        eq(documentBranches.state, Buffer.from(input.branch.state)),
      ),
    )
    .returning({ id: documentBranches.id });
  if (!casRow) throw new BranchPushCommitConflictError(input.branch.branchId);

  const [lineage] = await db
    .insert(pushLineage)
    .values({
      branchId: input.branch.branchId,
      documentId: input.branch.documentId,
      pushKind: input.receiptPayload.pushKind,
      journalIds: input.journalRows.map((row) => row.id),
      upstreamUpdateSeq: null,
      receiptPayload: input.receiptPayload,
      pushedByUserId: input.pushedByUserId ?? null,
      threadId: representativeThreadId(input.journalRows),
      turnId: representativeTurnId(input.journalRows),
      idempotencyKey: input.idempotencyKey,
      receiptId: input.receiptId ?? randomUUID(),
    })
    .returning();
  if (!lineage) throw new Error("Failed to record push lineage");

  if (input.journalRows.length > 0) {
    const pushedRows = await db
      .update(branchWriteJournal)
      .set({
        status: "pushed",
        pushedAt: now,
        reviewedBy: input.pushedByUserId ?? null,
        reviewedAt: now,
      })
      .where(
        and(
          inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
          inArray(
            branchWriteJournal.id,
            input.journalRows.map((row) => row.id),
          ),
        ),
      )
      .returning({ id: branchWriteJournal.id });
    if (pushedRows.length !== input.journalRows.length) {
      throw new BranchPushCommitConflictError(input.branch.branchId);
    }
  }

  return lineage;
}

function representativeThreadId(rows: BranchJournalRow[]): ThreadId | null {
  const ids = new Set(rows.map((row) => row.threadId));
  const [id] = ids;
  return ids.size === 1 && id !== null ? id : null;
}

function representativeTurnId(rows: BranchJournalRow[]): TurnId | null {
  const ids = new Set(rows.map((row) => row.turnId));
  const [id] = ids;
  return ids.size === 1 && id !== null ? id : null;
}

function mapJournalRow(row: typeof branchWriteJournal.$inferSelect): BranchJournalRow {
  return {
    id: row.id,
    branchId: row.branchId,
    generation: row.generation,
    wId: row.wId,
    source: row.source,
    threadId: row.threadId,
    turnId: row.turnId,
    actorUserId: row.actorUserId,
    updateData: row.updateData,
    draftBaseUpdateSeq: row.draftBaseUpdateSeq,
    status: row.status,
    updateMeta: row.updateMeta,
  };
}

function mapLineage(row: typeof pushLineage.$inferSelect): PushLineageRow {
  return {
    id: row.id,
    branchId: row.branchId,
    documentId: row.documentId,
    pushKind: row.pushKind,
    journalIds: row.journalIds,
    upstreamUpdateSeq: row.upstreamUpdateSeq,
    receiptPayload: row.receiptPayload as PushLineageRow["receiptPayload"],
    idempotencyKey: row.idempotencyKey,
    receiptId: row.receiptId,
    threadId: row.threadId,
    turnId: row.turnId,
  };
}

function aiWriteModeProjection(policy: "manual" | "auto"): "draft" | "direct" {
  return policy === "manual" ? "draft" : "direct";
}
