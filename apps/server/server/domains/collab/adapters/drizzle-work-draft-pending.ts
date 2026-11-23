/** Drizzle store for what is pending review in a Work: counts, the drafts changing a document and evidence. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import { drafts, threads, works } from "@meridian/database/schema";
import { and, asc, eq, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import { pendingDocuments, pendingFolders } from "../../context/tree/pending-documents.js";
import type { WorkDraftPendingStore } from "../domain/ports/work-draft-pending-store.js";

/**
 * What is pending in a Work is the one reviewable-pending predicate
 * (`context/tree/pending-documents.ts`), the review list's too: the Work count (with the folders it changes) and the document hint both
 * count by it, and the Works boundary reconciles each Work's stored count through it.
 */
export function createDrizzleWorkDraftPendingStore(db: Database): WorkDraftPendingStore {
  return {
    async countPendingByOwners({ workIds, rootThreadIds }) {
      if (workIds.length === 0 && rootThreadIds.length === 0) return [];
      const ids = (list: readonly string[]) =>
        sql.join(
          list.map((id) => sql`${id}::uuid`),
          sql`, `,
        );
      // The drafts these owners name.
      const named = sql.join(
        [
          workIds.length
            ? sql`SELECT w.draft_id FROM works w WHERE w.id IN (${ids(workIds)}) AND w.draft_id IS NOT NULL`
            : null,
          rootThreadIds.length
            ? sql`SELECT t.draft_id FROM threads t WHERE t.id IN (${ids(rootThreadIds)}) AND t.draft_id IS NOT NULL`
            : null,
        ].filter((clause) => clause !== null),
        sql` UNION `,
      );
      // One row per draft: its documents and its folders changed, whichever arm made each pending.
      const rows = await currentDrizzleDb(db).execute<{
        draft_id: string;
        project_id: string;
        work_id: string | null;
        root_thread_id: string | null;
        documents: number;
        folders: number;
      }>(sql`
        SELECT b.id AS draft_id, b.project_id::text AS project_id,
               (SELECT w.id::text FROM works w WHERE w.draft_id = b.id) AS work_id,
               (SELECT t.id::text FROM threads t WHERE t.draft_id = b.id) AS root_thread_id,
               coalesce(d.count, 0)::int AS documents, coalesce(f.count, 0)::int AS folders
        FROM drafts b
        LEFT JOIN (
          SELECT p.draft_id, count(DISTINCT p.document_id) AS count
          FROM (${pendingDocuments(named)}) p GROUP BY p.draft_id
        ) d ON d.draft_id = b.id
        LEFT JOIN (
          SELECT p.draft_id, count(DISTINCT p.folder_id) AS count
          FROM (${pendingFolders(named)}) p GROUP BY p.draft_id
        ) f ON f.draft_id = b.id
        WHERE b.id IN (${named})`);
      return rows.map((row) => ({
        draftId: row.draft_id,
        projectId: row.project_id,
        workId: row.work_id,
        rootThreadId: row.root_thread_id,
        documents: Number(row.documents),
        folders: Number(row.folders),
      }));
    },
    async countPendingInProject(projectId) {
      const [row] = await currentDrizzleDb(db)
        .select({ count: sql<number>`coalesce(sum(${drafts.pendingDocumentCount}), 0)::int` })
        .from(drafts)
        .where(eq(drafts.projectId, projectId));
      return row?.count ?? 0;
    },
    async listDraftsChangingDocument({ projectId, documentId }) {
      const tx = currentDrizzleDb(db);
      const inProject = sql`SELECT b.id FROM drafts b WHERE b.project_id = ${projectId}::uuid`;
      // The same membership as the counts, narrowed to one document. Archived Works and
      // lineages with no live member stay (their drafts remain reviewable); deleted Works and
      // drafts nothing names are out, since the review address needs a live owner's label.
      const lineageRoot = alias(threads, "lineage_root");
      const rows = await tx
        .select({
          draftId: drafts.id,
          originWorkId: works.id,
          originRootThreadId: lineageRoot.id,
          workName: works.name,
          isNoWork: works.isNoWork,
          rootTitle: lineageRoot.title,
        })
        .from(drafts)
        .leftJoin(works, eq(works.draftId, drafts.id))
        .leftJoin(lineageRoot, eq(lineageRoot.draftId, drafts.id))
        .where(
          and(
            eq(drafts.projectId, projectId),
            isNull(works.deletedAt),
            or(isNotNull(works.id), isNotNull(lineageRoot.id)),
            sql`${drafts.id} in (SELECT p.draft_id FROM (${pendingDocuments(inProject, documentId as DocumentId)}) p)`,
          ),
        )
        .orderBy(asc(drafts.createdAt), asc(drafts.id));
      return rows.map((row) => ({
        draftId: row.draftId,
        originWorkId: row.originWorkId,
        originRootThreadId: row.originRootThreadId,
        originLabel: row.originWorkId ? (row.isNoWork ? null : row.workName) : row.rootTitle,
      }));
    },
    async listDraftTextChanges(draftId, documentIds) {
      const only = documentIds?.length
        ? sql`AND r.document_id IN (${sql.join(
            documentIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : documentIds
          ? sql`AND false`
          : sql``;
      const rows = await currentDrizzleDb(db).execute<{
        document_id: string;
        updated_at: Date | string;
        pending: { changes: number; chats: string[]; writer: boolean };
      }>(sql`
        SELECT r.document_id::text AS document_id, d.updated_at, r.pending_changes -> ${draftId}::text AS pending
        FROM document_block_rooms r
        JOIN documents d ON d.id = r.document_id
        WHERE r.pending_changes ? ${draftId}::text ${only}
          AND (r.pending_changes -> ${draftId}::text ->> 'changes')::int > 0
        ORDER BY r.document_id`);
      return rows.map((row) => ({
        documentId: row.document_id as DocumentId,
        draftId,
        updatedAt: new Date(row.updated_at),
        writers: { threadIds: row.pending.chats, unattributed: row.pending.writer },
      }));
    },
  };
}
