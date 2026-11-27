import { type AnyColumn, type SQL, sql } from "drizzle-orm";

export function livingDocumentSql(documentId: SQL | AnyColumn): SQL {
  return sql`(exists (select 1 from tree_nodes t where t.id = ${documentId} and t.trash_record is null)
    or exists (select 1 from draft_tree_nodes b where b.id = ${documentId} and not b.deleted))`;
}
