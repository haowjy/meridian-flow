/** Drizzle store for what is pending review in a Work: counts, the branches changing a document and evidence. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { branches, documentDrafts, threads, works } from "@meridian/database/schema";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { pendingDocuments, pendingFolders } from "../../context/tree/pending-documents.js";
import { isPending, readDraftChanges } from "../domain/draft-changes.js";
import { materializeDraftRead } from "../domain/draft-store.js";
import type { WorkBranchPendingStore } from "../domain/ports/work-branch-pending-store.js";
import { createDrizzleDraftDispositionStore } from "./drizzle-draft-disposition.js";

/**
 * What is pending in a Work is the one reviewable-pending predicate
 * (`context/tree/pending-documents.ts`), the review list's too: the Work count (with the folders it changes) and the document hint both
 * count by it, and the Works boundary reconciles each Work's stored count through it.
 */
export function createDrizzleWorkBranchPendingStore(db: Database): WorkBranchPendingStore {
  const evidence = createDrizzleDraftDispositionStore(db);
  return {
    async countPendingByOwners({ workIds, rootThreadIds }) {
      if (workIds.length === 0 && rootThreadIds.length === 0) return [];
      const ids = (list: readonly string[]) =>
        sql.join(
          list.map((id) => sql`${id}::uuid`),
          sql`, `,
        );
      const owned = [
        workIds.length ? sql`b.origin_work_id IN (${ids(workIds)})` : null,
        rootThreadIds.length ? sql`b.origin_root_thread_id IN (${ids(rootThreadIds)})` : null,
      ].filter((clause) => clause !== null);
      const active = sql`SELECT b.id FROM branches b WHERE b.status = 'active'
        AND (${sql.join(owned, sql` OR `)})`;
      // One row per active branch: its documents and its folders changed, whichever arm made each pending.
      const rows = await currentDrizzleDb(db).execute<{
        branch_id: string;
        project_id: string;
        work_id: string | null;
        root_thread_id: string | null;
        documents: number;
        folders: number;
      }>(sql`
        SELECT b.id::text AS branch_id, b.project_id::text AS project_id,
               b.origin_work_id::text AS work_id, b.origin_root_thread_id::text AS root_thread_id,
               coalesce(d.count, 0)::int AS documents, coalesce(f.count, 0)::int AS folders
        FROM branches b
        LEFT JOIN (
          SELECT p.branch_id, count(DISTINCT p.document_id) AS count
          FROM (${pendingDocuments(active)}) p GROUP BY p.branch_id
        ) d ON d.branch_id = b.id
        LEFT JOIN (
          SELECT p.branch_id, count(DISTINCT p.folder_id) AS count
          FROM (${pendingFolders(active)}) p GROUP BY p.branch_id
        ) f ON f.branch_id = b.id
        WHERE b.id IN (${active})`);
      return rows.map((row) => ({
        branchId: row.branch_id,
        projectId: row.project_id,
        workId: row.work_id,
        rootThreadId: row.root_thread_id,
        documents: Number(row.documents),
        folders: Number(row.folders),
      }));
    },
    async countPendingInProject(projectId) {
      const [row] = await currentDrizzleDb(db)
        .select({ count: sql<number>`coalesce(sum(${branches.pendingDocumentCount}), 0)::int` })
        .from(branches)
        .where(and(eq(branches.projectId, projectId), eq(branches.status, "active")));
      return row?.count ?? 0;
    },
    async listBranchesChangingDocument({ projectId, documentId }) {
      const tx = currentDrizzleDb(db);
      const active = sql`SELECT b.id FROM branches b
        WHERE b.status = 'active' AND b.project_id = ${projectId}::uuid`;
      // The same membership as the counts, narrowed to one document. Archived Works and
      // lineages with no live member stay (their branches remain reviewable); deleted Works
      // and branches with no owner are out, since today's review address needs a live owner.
      const lineageRoot = alias(threads, "lineage_root");
      const rows = await tx
        .select({
          branchId: branches.id,
          originWorkId: works.id,
          originRootThreadId: lineageRoot.id,
          workName: works.name,
          isNoWork: works.isNoWork,
          rootTitle: lineageRoot.title,
        })
        .from(branches)
        .leftJoin(works, eq(works.id, branches.originWorkId))
        .leftJoin(lineageRoot, eq(lineageRoot.id, branches.originRootThreadId))
        .where(
          and(
            eq(branches.projectId, projectId),
            eq(branches.status, "active"),
            isNull(works.deletedAt),
            or(isNotNull(works.id), isNotNull(lineageRoot.id)),
            sql`${branches.id} in (SELECT p.branch_id FROM (${pendingDocuments(active, documentId as DocumentId)}) p)`,
          ),
        )
        .orderBy(asc(branches.createdAt), asc(branches.id));
      return rows.map((row) => ({
        branchId: row.branchId,
        originWorkId: row.originWorkId,
        originRootThreadId: row.originRootThreadId,
        originLabel: row.originWorkId ? (row.isNoWork ? null : row.workName) : row.rootTitle,
      }));
    },
    async listBranchDraftMetadata(branchId, documentIds) {
      const rows = await currentDrizzleDb(db)
        .select({
          draftId: documentDrafts.id,
          documentId: documentDrafts.documentId,
          updatedAt: documentDrafts.updatedAt,
          hasEffect: documentDrafts.hasEffect,
          textChanges: documentDrafts.textChanges,
        })
        .from(documentDrafts)
        .where(
          and(
            eq(documentDrafts.branchId, branchId),
            eq(documentDrafts.kind, "work_draft"),
            documentIds ? inArray(documentDrafts.documentId, [...documentIds]) : undefined,
          ),
        )
        .orderBy(asc(documentDrafts.id));

      return rows.map((row) => ({ ...row, branchId }));
    },
    /** The chats with a change in a pending change of the draft, and whether some pending change is no chat's. */
    async pendingWriters(draftId) {
      const cut = await evidence.capture(draftId);
      if (!cut?.draft.checkpoint) return { threadIds: [], unattributed: false };
      const doc = materializeDraftRead(cut.draft);
      try {
        const { reading, parts } = readDraftChanges(doc, cut.parts);
        const threadIds = new Set<string>();
        const held = new Set<number>();
        for (const part of cut.parts) {
          for (const change of parts.get(part.id)?.changes ?? []) {
            if (!isPending(change)) continue;
            if (part.owner) threadIds.add(part.owner.threadId);
            for (const group of change.sitsIn) held.add(group);
          }
        }
        return {
          threadIds: [...threadIds],
          unattributed: reading.pending.groups.some((_, index) => !held.has(index)),
        };
      } finally {
        doc.destroy();
      }
    },
  };
}
