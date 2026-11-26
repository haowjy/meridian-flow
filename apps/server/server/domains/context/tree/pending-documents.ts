/**
 * The one reviewable-pending predicate: a Work has a change to a document that review lists, the
 * Work's count counts and Apply all applies. It reads the Work's rows (`draft_tree_nodes`, the
 * view's difference from live, written by the replay of the list) and its text changes:
 *
 * - a document that exists only in the Work's draft (a creation);
 * - a document the Work's tree lacks while live shows it (a drafted delete);
 * - any other row the Work changed: it shows the document differently from live (a move,
 *   rename or reorder). A row that differs only in a twin's suffix is not one (`changed` is
 *   false), and a document in Trash in live is in Trash in every Work's view.
 * - the Work's fork of the document has a pending change, on a document the Work's tree shows: a
 *   drafted delete, or a document in no view, hides the text changes everywhere.
 *
 * A write and its undo net to no changed row, so they net to no item. The Work's review count adds the
 * folders its rows change (`pendingFolders`), stored beside the documents' so a surface can name
 * each; the open browser counts the same two sets from its own replay (`changedFolders` in
 * `@meridian/project-tree`, which also writes a row for a folder whose change cannot land), and
 * this stored count serves the Works it has not opened.
 */
import type { DocumentId } from "@meridian/contracts";
import { type SQL, sql } from "drizzle-orm";

function treeChanges(drafts: SQL, kind: "document" | "folder"): SQL {
  return sql`SELECT b.draft_id, b.id AS document_id
    FROM draft_tree_nodes b LEFT JOIN tree_nodes t ON t.id = b.id
    WHERE b.kind = ${kind} AND b.draft_id IN (${drafts}) AND b.changed AND (
      (b.exists_only_in_draft AND NOT b.deleted)
      OR (NOT b.exists_only_in_draft AND b.deleted AND t.trash_record IS NULL)
      OR (NOT b.exists_only_in_draft AND NOT b.deleted))`;
}

export function pendingDocuments(drafts: SQL, documentId?: DocumentId): SQL {
  const one = documentId ? sql` AND candidate.document_id = ${documentId}::uuid` : sql``;
  return sql`SELECT candidate.draft_id, candidate.document_id FROM (
      ${treeChanges(drafts, "document")}
      UNION
      SELECT text.draft_id, text.document_id FROM (${pendingText(drafts)}) text
      WHERE EXISTS (SELECT 1 FROM draft_tree_nodes x
          WHERE x.draft_id = text.draft_id AND x.id = text.document_id AND NOT x.deleted)
        OR (NOT EXISTS (SELECT 1 FROM draft_tree_nodes x
            WHERE x.draft_id = text.draft_id AND x.id = text.document_id)
          AND EXISTS (SELECT 1 FROM tree_nodes t
            WHERE t.id = text.document_id AND t.trash_record IS NULL))
    ) candidate
    JOIN documents d ON d.id = candidate.document_id
    WHERE true${one}`;
}

export function pendingText(drafts: SQL): SQL {
  return sql`SELECT f.draft_id, f.document_id FROM document_forks f
      WHERE f.draft_id IN (${drafts}) AND f.pending`;
}

export function pendingFolders(drafts: SQL): SQL {
  return sql`SELECT c.draft_id, c.document_id AS folder_id FROM (${treeChanges(drafts, "folder")}) c`;
}
