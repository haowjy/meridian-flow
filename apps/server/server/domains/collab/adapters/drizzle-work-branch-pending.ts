/** Drizzle store for what is pending review in a Work: counts, the branches changing a document, creators and evidence. */
import type { DocumentId, WorkId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { branches, documentDrafts, works } from "@meridian/database/schema";
import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { livingDocumentUses, pendingDocuments } from "../../context/tree/tree-view.js";
import { createDraftDispositionReader } from "../domain/draft-disposition.js";
import type { WorkBranchPendingStore } from "../domain/ports/work-branch-pending-store.js";
import { createDrizzleDraftDispositionStore } from "./drizzle-draft-disposition.js";

/**
 * What is pending in a Work is the tree view's one reviewable-pending predicate
 * (`pendingDocuments`), the review list's too: the Work count and the document hint both
 * count by it, and the Works boundary reconciles each Work's stored count through it.
 */
export function createDrizzleWorkBranchPendingStore(db: Database): WorkBranchPendingStore {
  const readDisposition = createDraftDispositionReader(createDrizzleDraftDispositionStore(db));
  return {
    async countPendingByWorkIds(workIds) {
      if (workIds.length === 0) return new Map();
      const tx = currentDrizzleDb(db);
      const active = sql`SELECT b.id FROM branches b WHERE b.status = 'active'
        AND b.origin_work_id IN (${sql.join(
          workIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`;
      // One row per Work and document, whichever arm made it pending.
      const rows = await tx.execute<{ work_id: string | null; count: number }>(sql`
        SELECT b.origin_work_id::text AS work_id, count(DISTINCT p.document_id)::int AS count
        FROM (${pendingDocuments(active)}) p JOIN branches b ON b.id = p.branch_id
        GROUP BY b.origin_work_id`);
      return new Map(
        rows.flatMap(({ work_id, count }) => (work_id ? [[work_id as WorkId, Number(count)]] : [])),
      );
    },
    async listBranchesChangingDocument({ projectId, documentId }) {
      const tx = currentDrizzleDb(db);
      const active = sql`SELECT b.id FROM branches b
        WHERE b.status = 'active' AND b.project_id = ${projectId}::uuid`;
      // The same membership as the Work counts, narrowed to one document. Archived Works stay
      // (their branches remain reviewable); deleted Works and branches whose origin Work is
      // gone are out, since today's review address needs a live Work.
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
            sql`${branches.id} in (SELECT p.branch_id FROM (${pendingDocuments(active, documentId as DocumentId)}) p)`,
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
