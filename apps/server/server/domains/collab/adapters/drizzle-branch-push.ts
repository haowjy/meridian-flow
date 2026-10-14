/** Drizzle store for durable branch pushes into the live Yjs journal. */
import { randomUUID } from "node:crypto";
import type { DraftId } from "@meridian/contracts";
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branchPushSettlementBatches,
  branchPushSettlementPayloads,
  branchWriteJournal,
  documentBranches,
  documentEditParts,
  documentEdits,
  drafts,
  draftTreeChanges,
  pushLineage,
  works,
} from "@meridian/database/schema";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import type { DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { branchDraftWork, runWithActiveWorkDrafts } from "../../../shared/work-draft-lifecycle.js";
import type { NoticePort } from "../../notices/index.js";
import { WorkLifecycleUnavailableError } from "../../projects/domain/work-lifecycle.js";
import type { WorkProjectionMutation } from "../../projects/index.js";
import type {
  BranchJournalReadStore,
  BranchJournalRow,
  PreparedPushCommit,
  PushCommitStore,
  PushLineageRow,
} from "../domain/branch-push-contracts.js";
import { persistDurableTrailRecords } from "../domain/branch-trail-projection.js";
import { DRAFT_TREE_STEP } from "../domain/draft-tree-payload.js";
import type { ChangeTrailPersistence } from "../domain/ports/change-trail-persistence.js";
import type {
  WorkDraftPendingEvidence,
  WorkDraftPendingStore,
} from "../domain/ports/work-draft-pending-store.js";
import { attachBatchWithinTx, claimCommandWithinTx } from "./drizzle-draft-commands.js";
import {
  assertRootOwnedSettlement,
  type StageSettlementBatchWithinTx,
} from "./drizzle-pending-settlement.js";
import { mapLineage } from "./drizzle-settlement-member.js";

/** Global lock order for multi-document push batches — matches journal appendBatch. */
export function sortPushesByDocumentId<T extends { branch: { documentId: string } }>(
  pushes: readonly T[],
): T[] {
  return [...pushes].sort((left, right) =>
    left.branch.documentId.localeCompare(right.branch.documentId),
  );
}

export function createDrizzleBranchJournalReadStore(db: Database): BranchJournalReadStore {
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
      const rows = await currentDrizzleDb(db)
        .select({
          row: branchWriteJournal,
          editKind: documentEdits.kind,
        })
        .from(branchWriteJournal)
        .leftJoin(
          documentEditParts,
          sql`
          ${documentEditParts.origin}->>'kind' = 'pending'
          and ${documentEditParts.origin}->>'branchId' = ${branchWriteJournal.branchId}::text
          and ${documentEditParts.origin}->>'generation' = ${branchWriteJournal.generation}::text
          and ${documentEditParts.origin}->>'rowId' = ${branchWriteJournal.id}::text
        `,
        )
        .leftJoin(documentEdits, eq(documentEdits.id, documentEditParts.editId))
        .where(and(...conditions))
        .orderBy(branchWriteJournal.id);
      // A row can carry several parts of one edit: one entry per row, in journal order.
      const byRow = new Map<number, ReturnType<typeof mapJournalRow>>();
      for (const { row, editKind } of rows) {
        const seen = byRow.get(row.id);
        if (!seen || (!seen.editKind && editKind)) {
          byRow.set(row.id, { ...mapJournalRow(row), ...(editKind ? { editKind } : {}) });
        }
      }
      return [...byRow.values()];
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
      // A save's attribution reads inside its own transaction: the root pool handle would
      // wait on another connection and miss that transaction's uncommitted rows.
      const rows = await currentDrizzleDb(db)
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
  };
}

/** Thrown inside the staging transaction to roll back its command claim with it. */
class LineageConflictAfterClaim extends Error {
  constructor(readonly push: PushLineageRow) {
    super("A lineage conflict ended staging after the command was claimed");
    this.name = "LineageConflictAfterClaim";
  }
}

export function createDrizzlePushCommitStore(
  db: Database,
  stageSettlementBatchWithinTx: StageSettlementBatchWithinTx,
  changeTrails: ChangeTrailPersistence,
  notices?: NoticePort,
  workProjection?: WorkProjectionMutation,
): PushCommitStore {
  const mutatePending = <T>(branchIds: readonly string[], operation: () => Promise<T>) =>
    workProjection ? workProjection.mutatePendingBranches(branchIds, operation) : operation();
  return {
    async commitPushBatch(input) {
      assertRootOwnedSettlement("Branch push staging");
      const branchIds = input.pushes.map(({ branch }) => branch.branchId);
      const firstCommitted = async () => {
        for (const prepared of sortPushesByDocumentId(input.pushes)) {
          const existing = await findLineage(currentDrizzleDb(db), prepared.idempotencyKey);
          if (existing) return existing;
        }
        return null;
      };
      return runWithActiveWorkDrafts(db, { branchIds }, () =>
        mutatePending(branchIds, async () => {
          const txDb = currentDrizzleDb(db);
          // The command's claim is the transaction's first write; losing it stages nothing.
          if (input.command && !(await claimCommandWithinTx(txDb, input.command))) {
            return { status: "command_exists" as const };
          }
          const existing = await firstCommitted();
          // A claim with no batch can never settle: roll it back with this transaction and
          // let the caller's retry claim again (§4.6).
          if (existing && input.command) throw new LineageConflictAfterClaim(existing);
          if (existing) return { status: "conflict" as const, push: existing };
          const sorted = sortPushesByDocumentId(input.pushes);
          // Every document lock before any trail lock, as completion takes them.
          for (const prepared of sorted)
            await lockDocumentMutation(txDb, prepared.branch.documentId);
          const staged = [];
          for (const prepared of sorted) {
            staged.push({
              prepared,
              push: mapLineage(await commitPreparedPush(txDb, prepared)),
            });
          }
          // A durable commit requires its trail bundle: every push's, in one record.
          if (staged.length > 0) {
            await persistDurableTrailRecords(
              staged.map(({ prepared, push }) => ({ record: prepared.trail, push })),
              changeTrails,
              notices,
            );
          }
          await stageSettlementBatchWithinTx(
            txDb,
            input.settlement,
            staged,
            input.payloads,
            input.holds,
          );
          if (input.command) {
            await attachBatchWithinTx(txDb, input.command.commandId, input.settlement.batchId);
          }
          return { status: "inserted" as const, pushes: staged.map(({ push }) => push) };
        }),
      ).catch(async (error: unknown) => {
        if (error instanceof LineageConflictAfterClaim) {
          return { status: "conflict" as const, push: error.push };
        }
        if (!(error instanceof WorkLifecycleUnavailableError)) throw error;
        // Archive can win after another process committed this exact attempt.
        // A durable receipt is history, not permission to perform another write.
        const existing = await firstCommitted();
        if (existing) return { status: "conflict" as const, push: existing };
        throw error;
      });
    },
  };
}

/** What bounds a read of the item relation: the Works', one document's, or one draft's items. */
type ItemScope = {
  workIds?: readonly WorkId[];
  documentId?: DocumentId;
  draftId?: DraftId;
};

/**
 * The one SQL item relation (contract §4.2), twin of `draft-review-items.ts`'s `isListed`: every
 * listed item of an active draft as `(draftId, workId, documentId)`. Two arms, unioned. An edited
 * item is an active text branch with `has_effect OR blocking`; a created item is a document the
 * draft created, listed with no text yet (a blank create, a branchless image). Every count, hint
 * and strip selects from here and never rebuilds an arm, so the list and the counts cannot drift.
 */
export function listedItemRelation(tx: DrizzleDb, scope: ItemScope = {}) {
  const edited = tx
    .select({
      draftId: drafts.id,
      workId: drafts.originWorkId,
      documentId: documentBranches.documentId,
    })
    .from(documentBranches)
    .innerJoin(branchDraftWork.drafts, branchDraftWork.on)
    .where(
      and(
        eq(drafts.status, "active"),
        eq(documentBranches.kind, "work_draft"),
        eq(documentBranches.status, "active"),
        sql`(${documentBranches.hasEffect} OR ${documentBranches.blocking})`,
        scope.workIds ? inArray(drafts.originWorkId, [...scope.workIds]) : undefined,
        scope.documentId ? eq(documentBranches.documentId, scope.documentId) : undefined,
        scope.draftId ? eq(drafts.id, scope.draftId) : undefined,
      ),
    );
  const created = tx
    .select({
      draftId: drafts.id,
      workId: drafts.originWorkId,
      documentId: draftTreeChanges.nodeId,
    })
    .from(draftTreeChanges)
    .innerJoin(drafts, eq(drafts.id, draftTreeChanges.draftId))
    .where(
      and(
        eq(drafts.status, "active"),
        eq(draftTreeChanges.nodeKind, "document"),
        scope.workIds ? inArray(drafts.originWorkId, [...scope.workIds]) : undefined,
        scope.documentId ? eq(draftTreeChanges.nodeId, scope.documentId) : undefined,
        scope.draftId ? eq(drafts.id, scope.draftId) : undefined,
      ),
    );
  return edited.union(created);
}

export function createDrizzleWorkDraftPendingStore(db: Database): WorkDraftPendingStore {
  return {
    async countPendingByWorkIds(workIds) {
      if (workIds.length === 0) return new Map();
      const documents = new Map<WorkId, Set<string>>();
      for (const { workId, documentId } of await listedItemRelation(currentDrizzleDb(db), {
        workIds,
      })) {
        if (!workId) continue;
        const set = documents.get(workId as WorkId) ?? new Set<string>();
        set.add(documentId);
        documents.set(workId as WorkId, set);
      }
      return new Map([...documents].map(([workId, set]) => [workId, set.size]));
    },
    async listDraftsChangingDocument({ projectId, documentId }) {
      const tx = currentDrizzleDb(db);
      const listed = [
        ...new Set((await listedItemRelation(tx, { documentId })).map((r) => r.draftId)),
      ];
      if (listed.length === 0) return [];
      // Archived Works stay (their drafts remain reviewable); deleted Works and drafts whose
      // origin Work is gone are out, since today's review address needs a live Work.
      const rows = await tx
        .select({
          draftId: drafts.id,
          originWorkId: works.id,
          name: works.name,
          isNoWork: works.isNoWork,
        })
        .from(drafts)
        .innerJoin(works, eq(works.id, drafts.originWorkId))
        .where(
          and(
            eq(drafts.projectId, projectId),
            eq(drafts.status, "active"),
            isNull(works.deletedAt),
            inArray(drafts.id, listed),
          ),
        )
        .orderBy(asc(drafts.createdAt), asc(drafts.id));
      return rows.map((row) => ({
        draftId: row.draftId,
        originWorkId: row.originWorkId,
        originWorkName: row.isNoWork ? null : row.name,
      }));
    },
    async listCreators(draftId, documentIds) {
      const rows = await currentDrizzleDb(db)
        .select({ documentId: draftTreeChanges.nodeId, threadId: draftTreeChanges.createdThreadId })
        .from(draftTreeChanges)
        .where(
          and(
            eq(draftTreeChanges.draftId, draftId),
            eq(draftTreeChanges.nodeKind, "document"),
            isNotNull(draftTreeChanges.createdThreadId),
            documentIds ? inArray(draftTreeChanges.nodeId, [...documentIds]) : undefined,
          ),
        );
      return new Map(
        rows.flatMap((row) =>
          row.threadId ? [[row.documentId as DocumentId, row.threadId as string] as const] : [],
        ),
      );
    },
    async listSettling(draftId) {
      const rows = await currentDrizzleDb(db)
        .select({ payload: branchPushSettlementPayloads.payload })
        .from(branchPushSettlementPayloads)
        .innerJoin(
          branchPushSettlementBatches,
          eq(branchPushSettlementBatches.id, branchPushSettlementPayloads.batchId),
        )
        .where(
          and(
            eq(branchPushSettlementPayloads.stepKind, DRAFT_TREE_STEP),
            eq(branchPushSettlementBatches.state, "pending"),
            sql`${branchPushSettlementPayloads.payload}->>'draftId' = ${draftId}`,
          ),
        );
      const keys = new Set<string>();
      for (const { payload } of rows) {
        const items = (payload as { items?: { itemKey?: string }[] }).items ?? [];
        for (const item of items) if (item.itemKey) keys.add(item.itemKey);
      }
      return keys;
    },
    async listDraftBranchEvidence(draftId, documentIds) {
      // One row per branch and writing chat: the journal is aggregated here, not shipped.
      const writer = sql<
        string | null
      >`case when ${branchWriteJournal.source} = 'agent' then ${branchWriteJournal.threadId} end`;
      const rows = await currentDrizzleDb(db)
        .select({
          branchId: documentBranches.id,
          documentId: documentBranches.documentId,
          generation: documentBranches.generation,
          updatedAt: documentBranches.updatedAt,
          hasEffect: documentBranches.hasEffect,
          blocking: documentBranches.blocking,
          writer,
          lastWrite: sql<number | null>`max(${branchWriteJournal.id})`,
        })
        .from(documentBranches)
        .leftJoin(
          branchWriteJournal,
          and(
            eq(branchWriteJournal.branchId, documentBranches.id),
            eq(branchWriteJournal.generation, documentBranches.generation),
            inArray(branchWriteJournal.status, ["active", "rollback_pending"]),
          ),
        )
        .where(
          and(
            eq(documentBranches.draftId, draftId),
            eq(documentBranches.kind, "work_draft"),
            eq(documentBranches.status, "active"),
            documentIds ? inArray(documentBranches.documentId, [...documentIds]) : undefined,
          ),
        )
        .groupBy(documentBranches.id, writer)
        .orderBy(asc(documentBranches.id), sql`max(${branchWriteJournal.id}) desc nulls last`);

      const evidence = new Map<string, WorkDraftPendingEvidence>();
      for (const row of rows) {
        const branch = evidence.get(row.branchId) ?? {
          branch: {
            branchId: row.branchId,
            documentId: row.documentId,
            draftId,
            generation: row.generation,
            updatedAt: row.updatedAt,
            hasEffect: row.hasEffect,
            blocking: row.blocking,
          },
          agentThreadIds: [],
        };
        if (row.writer) branch.agentThreadIds.push(row.writer);
        evidence.set(row.branchId, branch);
      }
      return [...evidence.values()];
    },
  };
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
): Promise<typeof pushLineage.$inferSelect> {
  await lockDocumentMutation(db, input.branch.documentId);
  // The member stages against the branch state it was planned on: a writer admission that landed
  // since leaves the branch's own CAS to the settlement that patches its base.
  const [lineage] = await db
    .insert(pushLineage)
    .values({
      branchId: input.branch.branchId,
      branchGeneration: input.branch.generation,
      documentId: input.branch.documentId,
      // A content member moves no journal rows (the column stays NOT NULL for historical rows).
      journalIds: [],
      applyPayload: input.input,
      upstreamUpdateSeq: null,
      pushedByUserId: input.pushedByUserId ?? null,
      threadId: null,
      turnId: null,
      idempotencyKey: input.idempotencyKey,
      receiptId: input.receiptId ?? randomUUID(),
    })
    .returning();
  if (!lineage) throw new Error("Failed to record push lineage");
  return lineage;
}

function mapJournalRow(row: typeof branchWriteJournal.$inferSelect): BranchJournalRow {
  return {
    id: row.id,
    branchId: row.branchId,
    generation: row.generation,
    wId: row.wId,
    toolCallId: row.toolCallId,
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
