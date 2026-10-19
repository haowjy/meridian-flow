/** Drizzle store for what is pending review in a Work: counts, the branches changing a document, creators and evidence. */
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { branches, documentDrafts, works } from "@meridian/database/schema";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { draftBranchWork } from "../../../shared/work-branch-lifecycle.js";
import { livingDocumentUses } from "../../context/tree/tree-view.js";
import { createDraftDispositionReader } from "../domain/draft-disposition.js";
import type { WorkBranchPendingStore } from "../domain/ports/work-branch-pending-store.js";
import { createDrizzleDraftDispositionStore } from "./drizzle-draft-disposition.js";

/**
 * The one SQL membership rule for a draft to count as a pending document, twin of
 * `branch-review-items.ts` (active with `hasEffect`). The Work count and the
 * document hint both filter by it; the Works boundary reconciles each Work's stored count
 * through that count.
 */
const reviewableWorkDraft = and(
  eq(documentDrafts.kind, "work_draft"),
  eq(documentDrafts.status, "active"),
  eq(documentDrafts.hasEffect, true),
);

export function createDrizzleWorkBranchPendingStore(db: Database): WorkBranchPendingStore {
  const readDisposition = createDraftDispositionReader(createDrizzleDraftDispositionStore(db));
  return {
    async countPendingByWorkIds(workIds) {
      if (workIds.length === 0) return new Map();
      const tx = currentDrizzleDb(db);
      const branchTreeChanges = livingDocumentUses(tx);
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
      const branchTreeChanges = livingDocumentUses(tx);
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
      const branchTreeChanges = livingDocumentUses(currentDrizzleDb(db));
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
    async listBranchDraftMetadata(branchId, documentIds) {
      const rows = await currentDrizzleDb(db)
        .select({
          draftId: documentDrafts.id,
          documentId: documentDrafts.documentId,
          updatedAt: documentDrafts.updatedAt,
          hasEffect: documentDrafts.hasEffect,
        })
        .from(documentDrafts)
        .where(
          and(
            eq(documentDrafts.branchId, branchId),
            eq(documentDrafts.kind, "work_draft"),
            eq(documentDrafts.status, "active"),
            documentIds ? inArray(documentDrafts.documentId, [...documentIds]) : undefined,
          ),
        )
        .orderBy(asc(documentDrafts.id));

      return rows.map((row) => ({ ...row, branchId }));
    },
    async pendingThreadIds(draftId) {
      const view = await readDisposition(draftId);
      const members = new Set<number>();
      for (const classification of view?.classifications.values() ?? [])
        for (const member of classification.members) members.add(member);
      const agentThreadIds = new Set<string>();
      // Receipt order is newest first; classification member order need not be.
      for (const [index, part] of (view?.parts ?? []).entries())
        if (members.has(index) && part.owner) agentThreadIds.add(part.owner.threadId);
      return [...agentThreadIds];
    },
  };
}
