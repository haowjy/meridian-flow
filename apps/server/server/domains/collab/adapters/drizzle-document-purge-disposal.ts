/** Collab's half of a content purge: nothing may write the documents once their content is released. */
import type { DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentPurgeDraftDisposal } from "../../context/ports/document-trash.js";
import { pendingDocuments } from "../../context/tree/pending-documents.js";
import type { DraftClose } from "./drizzle-draft-close.js";
import { lockActiveDrafts } from "./drizzle-draft-close.js";

/**
 * Draft appends lock only their draft row, so the documents' keys and then every active draft row
 * that can write them are taken before the pending check: "no pending change" is then stable until
 * the caller commits. The caller holds the tree list's lock, which sorts before both.
 */
export function createDrizzleDocumentPurgeDisposal(
  db: Database,
  deps: { close: Pick<DraftClose, "closeDrafts"> },
): DocumentPurgeDraftDisposal {
  return {
    async settle(documentIds) {
      if (documentIds.length === 0) return "closed";
      const tx = currentDrizzleDb(db);
      const sorted = [...new Set(documentIds)].sort();
      for (const id of sorted) await lockDocumentMutation(tx, id);
      await lockActiveDrafts(tx, { documentIds: sorted });
      const [held] = await tx.execute<{ held: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM (${pendingDocuments(sql`SELECT id FROM branches WHERE status = 'active'`)}) p
          WHERE p.document_id IN (${sql.join(
            sorted.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
        ) AS held`);
      if (held?.held) return "pending";
      await deps.close.closeDrafts(
        tx,
        { documentIds: sorted as DocumentId[] },
        "document_discarded",
      );
      return "closed";
    },
  };
}
