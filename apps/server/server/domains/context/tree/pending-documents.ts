/**
 * The one reviewable-pending predicate: a Work has a change to a document that review lists, the
 * Work's count counts and Apply all applies. It reads the Work's rows (`branch_tree_nodes`, the
 * view's difference from live, written by the replay of the list) and its text changes:
 *
 * - a document that exists only in the Work's draft (a creation);
 * - a document the Work's tree lacks while live shows it (a drafted delete);
 * - any other row the Work changed: it shows the document differently from live (a move,
 *   rename or reorder). A row that differs only in a twin's suffix is not one (`changed` is
 *   false), and a document in Trash in live is in Trash in every Work's view.
 * - the Work's suggestions in the Live document, on a document the Work's tree shows: a drafted
 *   delete, or a document in no view, hides the text changes everywhere.
 *
 * A write and its undo net to no changed row, so they net to no item. The Work's review count adds the
 * folders its rows change (`pendingFolders`), stored beside the documents' so a surface can name
 * each; the open browser counts the same two sets from its own replay (`changedFolders` in
 * `@meridian/project-tree`, which also writes a row for a folder whose change cannot land), and
 * this stored count serves the Works it has not opened.
 */
import type { DocumentId } from "@meridian/contracts";
import { type SQL, sql } from "drizzle-orm";

/** The rows of a Work's differing nodes of `kind` that count, as `(branch_id, node_id)`. */
function treeChanges(branches: SQL, kind: "document" | "folder"): SQL {
  return sql`SELECT b.branch_id, b.id AS document_id
    FROM branch_tree_nodes b LEFT JOIN tree_nodes t ON t.id = b.id
    WHERE b.kind = ${kind} AND b.branch_id IN (${branches}) AND b.changed AND (
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
      ${treeChanges(branches, "document")}
      UNION
      SELECT text.branch_id, text.document_id FROM (${pendingText(branches)}) text
      WHERE EXISTS (SELECT 1 FROM branch_tree_nodes x
          WHERE x.branch_id = text.branch_id AND x.id = text.document_id AND NOT x.deleted)
        OR (NOT EXISTS (SELECT 1 FROM branch_tree_nodes x
            WHERE x.branch_id = text.branch_id AND x.id = text.document_id)
          AND EXISTS (SELECT 1 FROM tree_nodes t
            WHERE t.id = text.document_id AND t.trash_record IS NULL))
    ) candidate
    JOIN documents d ON d.id = candidate.document_id
    WHERE true${one}`;
}

/**
 * The documents a Work has text changes in, as `(branch_id, document_id)`: the Work's suggestions
 * in the Live document, counted by the document's derivation in
 * `document_block_rooms.pending_changes`.
 */
export function pendingText(branches: SQL): SQL {
  return sql`SELECT b.id AS branch_id, r.document_id FROM branches b
      JOIN document_block_rooms r ON r.pending_changes ? ${ownerKeyOfBranch(sql`b`)}
      WHERE b.id IN (${branches})
        AND (r.pending_changes -> ${ownerKeyOfBranch(sql`b`)} ->> 'changes')::int > 0`;
}

/** The `draftOwnerKey` of the branch row `b`: the key its Work's suggestions carry. */
export function ownerKeyOfBranch(b: SQL): SQL {
  return sql`CASE WHEN ${b}.origin_work_id IS NOT NULL THEN 'work:' || ${b}.origin_work_id::text
    ELSE 'lineage:' || ${b}.origin_root_thread_id::text END`;
}

/**
 * The folders a Work's tree changes (created, moved, renamed, deleted, or unable to land), as
 * `(branch_id, folder_id)`: every changed folder is one item of the Changes list and one of the
 * count.
 */
export function pendingFolders(branches: SQL): SQL {
  return sql`SELECT c.branch_id, c.document_id AS folder_id FROM (${treeChanges(branches, "folder")}) c`;
}
