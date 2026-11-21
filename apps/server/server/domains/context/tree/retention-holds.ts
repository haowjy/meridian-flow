/**
 * Retention's one question: can anything still bring this document back? A Work's view is kept
 * for every Work that can come back (open, archived, or deleted and restorable), so a document
 * is held while
 *
 * - a row of a kept view shows it (`draft_tree_nodes`: the Work drafted a create of it, kept a
 *   delete's victim, moved it...), or
 * - a branch that has not ended has suggestions in it, whatever the rows say (they outlive a
 *   delete of their document, and a Discard of that delete brings both back).
 *
 * The third source, an unsettled record in the list for a kept Work, is read from the list's
 * copy by the paths that hold its key (`purgeEntry`, `purgeUnviewed`); its rows are the first
 * arm here. Ask before the purge: a purge removes the rows this reads.
 */
import type { DocumentId } from "@meridian/contracts";
import { type SQL, sql } from "drizzle-orm";
import { pendingText } from "./pending-documents.js";

/** `(draft_id, document_id)` for each hold, narrowed to `documentIds` when given. */
export function retentionHolds(documentIds?: readonly DocumentId[]): SQL {
  const only = (column: string) =>
    documentIds
      ? sql` AND ${sql.raw(column)} IN (${sql.join(
          documentIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql``;
  return sql`SELECT b.draft_id, b.id AS document_id FROM draft_tree_nodes b
      WHERE b.kind = 'document'${only("b.id")}
    UNION
    SELECT text.draft_id, text.document_id
      FROM (${pendingText(sql`SELECT id FROM drafts`)}) text
      WHERE true${only("text.document_id")}`;
}
