/**
 * The living-document requirement: some view shows the document (live shows it, or a Work's
 * tree does). Every write that may create or change a document's Yjs state proves it under
 * the document's mutation lock; a document in Trash, in no view, or without a row is not
 * living. A write into a Work's draft asks the narrower question (`requireDraftableDocument`):
 * that Work's tree shows it.
 */
import { DocumentNotFoundError } from "@meridian/agent-edit/integration";
import type { BranchId, DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { documents, treeNodes } from "@meridian/database/schema";
import { type AnyColumn, and, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";
import { currentDrizzleDb, type DrizzleDb } from "../../../shared/drizzle-transaction.js";
import { visibleDocuments } from "./tree-relations.js";

type LivingDocumentDb = Pick<Database, "select">;

/**
 * The requirement as a predicate on a document-id expression, for a statement that already
 * runs (an admission's head update), so the admitted path pays no extra query.
 */
export function livingDocumentSql(documentId: SQL | AnyColumn): SQL {
  return sql`(exists (select 1 from tree_nodes t where t.id = ${documentId} and t.trash_record is null)
    or exists (select 1 from branch_tree_nodes b where b.id = ${documentId} and not b.deleted))`;
}

/** Why the document is not living: deleted, or in no view, or no row at all; null when it lives. */
export async function livingDocumentRefusal(
  db: LivingDocumentDb,
  documentId: DocumentId,
): Promise<DocumentNotFoundError | null> {
  const [row] = await db
    .select({ living: sql<boolean>`${livingDocumentSql(documents.id)}` })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  if (!row) return new DocumentNotFoundError(documentId, `Document ${documentId} does not exist`);
  if (row.living) return null;
  const [trashed] = await db
    .select({ id: treeNodes.id })
    .from(treeNodes)
    .where(and(eq(treeNodes.id, documentId), isNotNull(treeNodes.trashRecord)))
    .limit(1);
  return new DocumentNotFoundError(
    documentId,
    `Document ${documentId} ${trashed ? "was deleted" : "is in no tree"}`,
  );
}

/** Called under the document's mutation lock; throws the refusal when it is not living. */
export async function requireLivingDocument(
  db: LivingDocumentDb,
  documentId: DocumentId,
): Promise<void> {
  const refusal = await livingDocumentRefusal(db, documentId);
  if (refusal) throw refusal;
}

/** The ids of `documentIds` that this Work branch's tree shows. */
export async function shownInBranch(
  db: DrizzleDb,
  branchId: BranchId,
  documentIds: readonly DocumentId[],
): Promise<ReadonlySet<DocumentId>> {
  if (documentIds.length === 0) return new Set();
  const shown = visibleDocuments({ kind: "branch", branchId });
  const rows = await currentDrizzleDb(db)
    .select({ id: shown.id })
    .from(shown)
    .where(inArray(shown.id, [...documentIds]));
  return new Set(rows.map((row) => row.id));
}

/** Before a draft write that may create a draft row: the Work's tree shows the document. */
export async function requireDraftableDocument(
  db: DrizzleDb,
  documentId: DocumentId,
  branchId: BranchId,
): Promise<void> {
  if ((await shownInBranch(db, branchId, [documentId])).has(documentId)) return;
  await requireLivingDocument(currentDrizzleDb(db), documentId);
}
