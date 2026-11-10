/** Drizzle store for what is pending review in a Work: counts, the branches changing a document, the chats behind its tree rows and evidence. */
import type { DocumentId } from "@meridian/contracts/runtime";
import type { Database } from "@meridian/database";
import {
  branches,
  branchTreeChanges,
  documentDrafts,
  threads,
  works,
} from "@meridian/database/schema";
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
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
      // One row per active branch and document, whichever arm made it pending.
      const rows = await currentDrizzleDb(db).execute<{
        branch_id: string;
        project_id: string;
        work_id: string | null;
        root_thread_id: string | null;
        count: number;
      }>(sql`
        SELECT b.id::text AS branch_id, b.project_id::text AS project_id,
               b.origin_work_id::text AS work_id, b.origin_root_thread_id::text AS root_thread_id,
               coalesce(c.count, 0)::int AS count
        FROM branches b
        LEFT JOIN (
          SELECT p.branch_id, count(DISTINCT p.document_id) AS count
          FROM (${pendingDocuments(active)}) p GROUP BY p.branch_id
        ) c ON c.branch_id = b.id
        WHERE b.id IN (${active})`);
      return rows.map((row) => ({
        branchId: row.branch_id,
        projectId: row.project_id,
        workId: row.work_id,
        rootThreadId: row.root_thread_id,
        count: Number(row.count),
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
    async listTreeActors(branchId, documentIds) {
      // A creation counts only while its document lives; a move or delete stays the chat's
      // while the row holds it, whatever live did to the document since.
      const uses = livingDocumentUses(currentDrizzleDb(db));
      const scope = (table: typeof uses | typeof branchTreeChanges) =>
        and(
          eq(table.branchId, branchId),
          eq(table.nodeKind, "document"),
          documentIds ? inArray(table.nodeId, [...documentIds]) : undefined,
        );
      const [created, changed] = await Promise.all([
        currentDrizzleDb(db)
          .select({ documentId: uses.nodeId, threadId: uses.createdThreadId })
          .from(uses)
          .where(and(scope(uses), isNotNull(uses.createdThreadId))),
        currentDrizzleDb(db)
          .select({
            documentId: branchTreeChanges.nodeId,
            threadId: branchTreeChanges.changedThreadId,
          })
          .from(branchTreeChanges)
          .where(and(scope(branchTreeChanges), isNotNull(branchTreeChanges.changedThreadId))),
      ]);
      const actors = new Map<DocumentId, string[]>();
      for (const row of [...changed, ...created]) {
        if (!row.threadId) continue;
        const list = actors.get(row.documentId as DocumentId) ?? [];
        if (!list.includes(row.threadId)) list.push(row.threadId);
        actors.set(row.documentId as DocumentId, list);
      }
      return actors;
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
