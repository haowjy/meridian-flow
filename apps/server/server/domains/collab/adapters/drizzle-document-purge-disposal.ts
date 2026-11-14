/** Collab's half of a content purge: nothing may write the documents once their content is released. */
import type { DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentPurgeDraftDisposal } from "../../context/ports/document-trash.js";
import { retentionHolds } from "../../context/tree/retention-holds.js";
import type { DraftClose } from "./drizzle-draft-close.js";
import { lockActiveDrafts } from "./drizzle-draft-close.js";

/**
 * Draft appends lock only their draft row, so the documents' keys and then every active draft row
 * that can write them are taken before the check: "nothing holds the documents" is then stable
 * until the caller commits. The caller holds the tree list's lock, which sorts before both, and
 * asks before it purges: a purge removes the rows the check reads.
 */
export function createDrizzleDocumentPurgeDisposal(
  db: Database,
  deps: { close: Pick<DraftClose, "closeDrafts" | "registerRemoved"> },
): DocumentPurgeDraftDisposal {
  return {
    async settle(documentIds) {
      if (documentIds.length === 0) return "closed";
      const tx = currentDrizzleDb(db);
      const sorted = [...new Set(documentIds)].sort();
      for (const id of sorted) await lockDocumentMutation(tx, id);
      await lockActiveDrafts(tx, { documentIds: sorted });
      const [held] = await tx.execute<{ held: boolean }>(sql`
        SELECT EXISTS (SELECT 1 FROM (${retentionHolds(sorted as DocumentId[])}) p) AS held`);
      if (held?.held) return "pending";
      await deps.close.closeDrafts(
        tx,
        { documentIds: sorted as DocumentId[] },
        "document_discarded",
      );
      // A document in Trash keeps its room; the purge closes it, once the content is released.
      deps.close.registerRemoved(sorted as DocumentId[], {
        actor: null,
        time: new Date().toISOString(),
      });
      return "closed";
    },
  };
}
