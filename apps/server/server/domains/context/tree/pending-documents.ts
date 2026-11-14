/**
 * The one reviewable-pending predicate: a Work has a change to a document that review lists, the
 * Work's count counts and Apply all applies. It reads the Work's rows (`branch_tree_nodes`, the
 * view's difference from live, written by the replay of the list) and its active text drafts:
 *
 * - a document that exists only in the Work's draft (a creation);
 * - a document the Work's tree lacks while live shows it (a drafted delete);
 * - any other row: the Work shows the document differently from live (a move, rename,
 *   reorder, or a document live has in Trash that the Work keeps because it has a change on it).
 * - an active text draft with an effect on a document the Work's tree shows: a drafted delete,
 *   or a document in no view, hides the text changes everywhere.
 *
 * A write and its undo net to no row, so they net to no item.
 */
import type { DocumentId } from "@meridian/contracts";
import { type SQL, sql } from "drizzle-orm";

/** The rows of a Work's differing documents that count, as `(branch_id, document_id)`. */
function treeChanges(branches: SQL): SQL {
  return sql`SELECT b.branch_id, b.id AS document_id
    FROM branch_tree_nodes b LEFT JOIN tree_nodes t ON t.id = b.id
    WHERE b.kind = 'document' AND b.branch_id IN (${branches}) AND (
      (b.exists_only_in_draft AND NOT b.deleted)
      OR (NOT b.exists_only_in_draft AND b.deleted AND t.trash_record IS NULL)
      OR (NOT b.exists_only_in_draft AND NOT b.deleted))`;
}

/**
 * Every `(branch_id, document_id)` the predicate holds for, among the branches `branches`
 * selects (a SQL list of branch ids), narrowed to one document when given.
 */
export function pendingDocuments(branches: SQL, documentId?: DocumentId): SQL {
  const one = documentId ? sql` AND candidate.document_id = ${documentId}::uuid` : sql``;
  return sql`SELECT candidate.branch_id, candidate.document_id FROM (
      ${treeChanges(branches)}
      UNION
      SELECT dd.branch_id, dd.document_id FROM document_drafts dd
      WHERE dd.kind = 'work_draft' AND dd.status = 'active' AND dd.has_effect
        AND dd.branch_id IN (${branches})
        AND (
          EXISTS (SELECT 1 FROM branch_tree_nodes x
            WHERE x.branch_id = dd.branch_id AND x.id = dd.document_id AND NOT x.deleted)
          OR (NOT EXISTS (SELECT 1 FROM branch_tree_nodes x
              WHERE x.branch_id = dd.branch_id AND x.id = dd.document_id)
            AND EXISTS (SELECT 1 FROM tree_nodes t
              WHERE t.id = dd.document_id AND t.trash_record IS NULL)))
    ) candidate
    JOIN documents d ON d.id = candidate.document_id
    WHERE true${one}`;
}
