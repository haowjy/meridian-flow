/**
 * The living-document requirement: some view shows the document (live shows it, or a Work's
 * tree does). A document in Trash, in no view, or without a row is not living.
 */
import { type AnyColumn, type SQL, sql } from "drizzle-orm";

/** The requirement as a predicate on a document-id expression, for a statement already running. */
export function livingDocumentSql(documentId: SQL | AnyColumn): SQL {
  return sql`(exists (select 1 from tree_nodes t where t.id = ${documentId} and t.trash_record is null)
    or exists (select 1 from draft_tree_nodes b where b.id = ${documentId} and not b.deleted))`;
}
