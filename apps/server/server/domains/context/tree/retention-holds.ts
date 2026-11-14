/**
 * Retention's one question: can anything still bring this document back? A Work's view is kept
 * for every Work that can come back (open, archived, or deleted and restorable), so a document
 * is held while
 *
 * - a row of a kept view shows it (`branch_tree_nodes`: the Work drafted a create of it, kept a
 *   delete's victim, moved it...), or
 * - a branch that has not ended has an active text draft of it with an effect, whatever the
 *   rows say (a draft outlives a delete of its document, and a Discard of that delete brings
 *   both back).
 *
 * The third source, an unsettled record in the list for a kept Work, is read from the list's
 * copy by the paths that hold its key (`purgeEntry`, `purgeUnviewed`); its rows are the first
 * arm here. Ask before the purge: a purge removes the rows this reads.
 */
import type { DocumentId } from "@meridian/contracts";
import { type SQL, sql } from "drizzle-orm";

/** `(branch_id, document_id)` for each hold, narrowed to `documentIds` when given. */
export function retentionHolds(documentIds?: readonly DocumentId[]): SQL {
  const only = (column: string) =>
    documentIds
      ? sql` AND ${sql.raw(column)} IN (${sql.join(
          documentIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql``;
  return sql`SELECT b.branch_id, b.id AS document_id FROM branch_tree_nodes b
      JOIN branches br ON br.id = b.branch_id AND br.status = 'active'
      WHERE b.kind = 'document'${only("b.id")}
    UNION
    SELECT dd.branch_id, dd.document_id FROM document_drafts dd
      JOIN branches br ON br.id = dd.branch_id AND br.status = 'active'
      WHERE dd.kind = 'work_draft' AND dd.status = 'active' AND dd.has_effect${only("dd.document_id")}`;
}
