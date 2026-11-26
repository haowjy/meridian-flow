import type { DocumentId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../shared/document-mutation-lock.js";
import { currentDrizzleDb, runAfterDrizzleCommit } from "../../../shared/drizzle-transaction.js";
import type { DocumentPurgeDisposal } from "../../context/ports/document-trash.js";
import { retentionHolds } from "../../context/tree/retention-holds.js";

export function createDrizzleDocumentPurgeDisposal(
  db: Database,
  deps: {
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
      runAfterDrizzleCommit(() => deps.closeRemovedRooms(sorted));
      return "closed";
    },
  };
}
