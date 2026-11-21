/** Collab's half of a content purge: nothing may write the documents once their content is released. */
import type { DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, runAfterDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { DocumentPurgeDisposal } from "../../context/ports/document-trash.js";
import { retentionHolds } from "../../context/tree/retention-holds.js";

/**
 * Every write to a document takes its key, so the keys are taken before the check: "nothing holds
 * the documents" is then stable until the caller commits. The caller holds the tree list's lock,
 * which sorts before them, and asks before it purges: a purge removes the rows the check reads.
 */
export function createDrizzleDocumentPurgeDisposal(
  db: Database,
  deps: {
    /** After commit: the documents' live rooms close `4208`, while their removal still stands. */
    closeRemovedRooms(documentIds: readonly DocumentId[]): Promise<void>;
  },
): DocumentPurgeDisposal {
  return {
    async settle(documentIds) {
      if (documentIds.length === 0) return "closed";
      const tx = currentDrizzleDb(db);
      const sorted = [...new Set(documentIds)].sort() as DocumentId[];
      for (const id of sorted) await lockDocumentMutation(tx, id);
      const [held] = await tx.execute<{ held: boolean }>(sql`
        SELECT EXISTS (SELECT 1 FROM (${retentionHolds(sorted)}) p) AS held`);
      if (held?.held) return "pending";
      // A document in Trash keeps its room; the purge closes it, once the content is released.
      runAfterDrizzleCommit(() => deps.closeRemovedRooms(sorted));
      return "closed";
    },
  };
}
