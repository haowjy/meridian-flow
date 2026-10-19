/** Drizzle store for what is pending review in a Work: counts, the branches changing a document, creators and evidence. */
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branches,
  branchPushSettlementBatches,
  branchPushSettlementPayloads,
  branchTreeChanges,
  documentDrafts,
  draftWriteJournal,
  works,
} from "@meridian/database/schema";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { draftBranchWork } from "../../../shared/work-branch-lifecycle.js";
import { BRANCH_TREE_STEP } from "../domain/branch-tree-payload.js";
import type {
  WorkBranchPendingEvidence,
  WorkBranchPendingStore,
} from "../domain/ports/work-branch-pending-store.js";

/**
 * The one SQL membership rule for a draft to count as a pending document, twin of
 * `branch-review-items.ts` (`hasRows && (hasEffect || blocking)`). The Work count and the
 * document hint both filter by it; the Works boundary reconciles each Work's stored count
 * through that count (migration 0067's backfill spells it in SQL too).
 */
const reviewableWorkDraft = and(
  eq(documentDrafts.kind, "work_draft"),
  eq(documentDrafts.status, "active"),
  sql`(${documentDrafts.hasEffect} OR ${documentDrafts.blocking})`,
  sql`exists (
    select 1 from ${draftWriteJournal}
    where ${draftWriteJournal.draftId} = ${documentDrafts.id}
      and ${draftWriteJournal.generation} = ${documentDrafts.generation}
      and ${draftWriteJournal.status} in ('active', 'rollback_pending'))`,
);

export function createDrizzleWorkBranchPendingStore(db: Database): WorkBranchPendingStore {
  return {
    async countPendingByWorkIds(workIds) {
      if (workIds.length === 0) return new Map();
      const tx = currentDrizzleDb(db);
      const drafted = tx
        .select({ workId: draftBranchWork.workId, documentId: documentDrafts.documentId })
        .from(documentDrafts)
        .innerJoin(draftBranchWork.branches, draftBranchWork.on)
        .where(
          and(
            inArray(draftBranchWork.workId, workIds),
            eq(branches.status, "active"),
            reviewableWorkDraft,
          ),
        );
      // A created document is pending with no text yet (a draftless image, an empty create).
      const changed = tx
        .select({ workId: branches.originWorkId, documentId: branchTreeChanges.nodeId })
        .from(branchTreeChanges)
        .innerJoin(branches, eq(branches.id, branchTreeChanges.branchId))
        .where(
          and(
            inArray(branches.originWorkId, workIds),
            eq(branches.status, "active"),
            eq(branchTreeChanges.nodeKind, "document"),
          ),
        );
      // `union` (not `union all`) leaves each Work's document once, so a row is a document.
      const pending = drafted.union(changed).as("pending");
      const rows = await tx
        .select({ workId: pending.workId, count: sql<number>`count(*)::int` })
        .from(pending)
        .groupBy(pending.workId);
      return new Map(
        rows.flatMap(({ workId, count }) => (workId ? [[workId as WorkId, count]] : [])),
      );
    },
    async listBranchesChangingDocument({ projectId, documentId }) {
      const tx = currentDrizzleDb(db);
      // The same membership arms as the Work counts, narrowed to one document.
      const drafted = tx
        .select({ branchId: documentDrafts.branchId })
        .from(documentDrafts)
        .where(and(eq(documentDrafts.documentId, documentId), reviewableWorkDraft));
      const changed = tx
        .select({ branchId: branchTreeChanges.branchId })
        .from(branchTreeChanges)
        .where(
          and(eq(branchTreeChanges.nodeId, documentId), eq(branchTreeChanges.nodeKind, "document")),
        );
      // Archived Works stay (their branches remain reviewable); deleted Works and branches whose
      // origin Work is gone are out, since today's review address needs a live Work.
      const rows = await tx
        .select({
          branchId: branches.id,
          originWorkId: works.id,
          name: works.name,
          isNoWork: works.isNoWork,
        })
        .from(branches)
        .innerJoin(works, eq(works.id, branches.originWorkId))
        .where(
          and(
            eq(branches.projectId, projectId),
            eq(branches.status, "active"),
            isNull(works.deletedAt),
            sql`${branches.id} in (${drafted.union(changed)})`,
          ),
        )
        .orderBy(asc(branches.createdAt), asc(branches.id));
      return rows.map((row) => ({
        branchId: row.branchId,
        originWorkId: row.originWorkId,
        originWorkName: row.isNoWork ? null : row.name,
      }));
    },
    async listCreators(branchId, documentIds) {
      const rows = await currentDrizzleDb(db)
        .select({
          documentId: branchTreeChanges.nodeId,
          threadId: branchTreeChanges.createdThreadId,
        })
        .from(branchTreeChanges)
        .where(
          and(
            eq(branchTreeChanges.branchId, branchId),
            eq(branchTreeChanges.nodeKind, "document"),
            isNotNull(branchTreeChanges.createdThreadId),
            documentIds ? inArray(branchTreeChanges.nodeId, [...documentIds]) : undefined,
          ),
        );
      return new Map(
        rows.flatMap((row) =>
          row.threadId ? [[row.documentId as DocumentId, row.threadId as string] as const] : [],
        ),
      );
    },
    async listSettling(branchId) {
      const rows = await currentDrizzleDb(db)
        .select({ payload: branchPushSettlementPayloads.payload })
        .from(branchPushSettlementPayloads)
        .innerJoin(
          branchPushSettlementBatches,
          eq(branchPushSettlementBatches.id, branchPushSettlementPayloads.batchId),
        )
        .where(
          and(
            eq(branchPushSettlementPayloads.stepKind, BRANCH_TREE_STEP),
            eq(branchPushSettlementBatches.state, "pending"),
            sql`${branchPushSettlementPayloads.payload}->>'branchId' = ${branchId}`,
          ),
        );
      const keys = new Set<string>();
      for (const { payload } of rows) {
        const items = (payload as { items?: { itemKey?: string }[] }).items ?? [];
        for (const item of items) if (item.itemKey) keys.add(item.itemKey);
      }
      return keys;
    },
    async listBranchDraftEvidence(branchId, documentIds) {
      // One row per draft and writing chat: the journal is aggregated here, not shipped.
      const writer = sql<
        string | null
      >`case when ${draftWriteJournal.source} = 'agent' then ${draftWriteJournal.threadId} end`;
      const rows = await currentDrizzleDb(db)
        .select({
          draftId: documentDrafts.id,
          documentId: documentDrafts.documentId,
          generation: documentDrafts.generation,
          updatedAt: documentDrafts.updatedAt,
          hasEffect: documentDrafts.hasEffect,
          blocking: documentDrafts.blocking,
          writer,
          writes: sql<number>`count(${draftWriteJournal.id})::int`,
          lastWrite: sql<number | null>`max(${draftWriteJournal.id})`,
        })
        .from(documentDrafts)
        .leftJoin(
          draftWriteJournal,
          and(
            eq(draftWriteJournal.draftId, documentDrafts.id),
            eq(draftWriteJournal.generation, documentDrafts.generation),
            inArray(draftWriteJournal.status, ["active", "rollback_pending"]),
          ),
        )
        .where(
          and(
            eq(documentDrafts.branchId, branchId),
            eq(documentDrafts.kind, "work_draft"),
            eq(documentDrafts.status, "active"),
            documentIds ? inArray(documentDrafts.documentId, [...documentIds]) : undefined,
          ),
        )
        .groupBy(documentDrafts.id, writer)
        .orderBy(asc(documentDrafts.id), sql`max(${draftWriteJournal.id}) desc nulls last`);

      const evidence = new Map<string, WorkBranchPendingEvidence>();
      for (const row of rows) {
        const documentDraft = evidence.get(row.draftId) ?? {
          documentDraft: {
            draftId: row.draftId,
            documentId: row.documentId,
            branchId,
            generation: row.generation,
            updatedAt: row.updatedAt,
            hasEffect: row.hasEffect,
            blocking: row.blocking,
          },
          hasRows: false,
          agentThreadIds: [],
        };
        if (row.writes > 0) documentDraft.hasRows = true;
        if (row.writer) documentDraft.agentThreadIds.push(row.writer);
        evidence.set(row.draftId, documentDraft);
      }
      return [...evidence.values()];
    },
  };
}
