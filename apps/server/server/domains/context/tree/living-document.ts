/**
 * The living-document requirement: a document row exists and carries no tombstone. Every
 * write that may create or change a document's Yjs state proves it under the document's
 * mutation lock, which a removal also takes, so a removal that won the lock is seen here.
 * Its one exception is a draft that outlived a live delete (`survivingDraftDocuments`).
 */
import { DocumentNotFoundError } from "@meridian/agent-edit/integration";
import type { BranchId, DocumentId, WorkId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documents } from "@meridian/database/schema";
import { type AnyColumn, eq, type SQL, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { readRemovalRecords } from "./removal.js";
import { deletedDocument } from "./tree-view-sql.js";

type LivingDocumentDb = Pick<Database, "select">;

/**
 * The requirement as a predicate on a document-id expression, for a statement that already
 * runs (an admission's head update), so the admitted path pays no extra query.
 */
export function livingDocumentSql(documentId: SQL | AnyColumn): SQL {
  return sql`exists (select 1 from documents d where d.id = ${documentId} and d.deleted_at is null)`;
}

/** Why the document is not living: not found with its removal record, or no row at all. */
export async function livingDocumentRefusal(
  db: LivingDocumentDb,
  documentId: DocumentId,
): Promise<DocumentNotFoundError | null> {
  const [row] = await db
    .select({ deletedAt: documents.deletedAt })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!row) return new DocumentNotFoundError(documentId, `Document ${documentId} does not exist`);
  if (row.deletedAt === null) return null;
  const removal = (await readRemovalRecords(db, [documentId])).get(documentId);
  // No record means a Restore committed between the two reads: the document lives again.
  return removal
    ? new DocumentNotFoundError(documentId, `Document ${documentId} was ${removal.reason}`, {
        removal,
      })
    : null;
}

/** Called under the document's mutation lock; throws the refusal when it is not living. */
export async function requireLivingDocument(
  db: LivingDocumentDb,
  documentId: DocumentId,
): Promise<void> {
  const refusal = await livingDocumentRefusal(db, documentId);
  if (refusal) throw refusal;
}

/**
 * Which of `documentIds` are deleted yet keep an open draft destination in one branch (the
 * branch's id, or a Work's active branch): the deletion is the document's own or its
 * folder's (reason `deleted`; never a discard, a Work cascade or a deleted source), and the
 * branch has an active Work draft of it, which outlived the delete (D79). Admission's one
 * proof, for file facts and for draft creation under the document lock. It never reads
 * `has_effect`: a no-effect draft (an open tab, an Undo after Discard) stays writable, while
 * listing the document in the branch is the tree view's separate, pending-only question.
 */
export async function survivingDraftDocuments(
  db: DrizzleDb,
  branch: { branchId: BranchId } | { workId: WorkId },
  documentIds: readonly DocumentId[],
): Promise<ReadonlySet<DocumentId>> {
  if (documentIds.length === 0) return new Set();
  const rows = await currentDrizzleDb(db).execute<{ id: string }>(sql`
    SELECT d.id::text AS id FROM documents d
    JOIN context_sources s ON s.id = d.context_source_id AND s.deleted_at IS NULL
    JOIN document_drafts dd ON dd.document_id = d.id AND dd.kind = 'work_draft'
      AND dd.status = 'active'
    JOIN branches b ON b.id = dd.branch_id AND b.status = 'active'
    WHERE d.id IN (${sql.join(
      documentIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
      AND ${deletedDocument}
      AND ${"branchId" in branch ? sql`b.id = ${branch.branchId}::uuid` : sql`b.origin_work_id = ${branch.workId}::uuid`}`);
  return new Set(rows.map((row) => row.id as DocumentId));
}

/**
 * Under the document's mutation lock, before a draft write that may create a draft row: the
 * document lives, or its draft in this branch outlived a live delete of it.
 */
export async function requireDraftableDocument(
  db: DrizzleDb,
  documentId: DocumentId,
  branchId: BranchId,
): Promise<void> {
  if ((await survivingDraftDocuments(db, { branchId }, [documentId])).has(documentId)) return;
  await requireLivingDocument(currentDrizzleDb(db), documentId);
}
