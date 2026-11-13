import type { DocumentId } from "@meridian/contracts";
import type { DocumentRemovalRecord } from "@meridian/contracts/protocol";
import type { Database } from "@meridian/database";
import { treeNodes } from "@meridian/database/schema";
import { and, inArray, isNotNull } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentRemovals } from "../ports/document-removal.js";

/**
 * A document is removed while its node is in Trash. The delete's author lives in the list, which
 * this reader does not open, so the record names no actor.
 */
export function createTrashRemovals(db: Database): DocumentRemovals {
  return {
    async lookup(documentIds) {
      const out = new Map<DocumentId, DocumentRemovalRecord>();
      if (documentIds.length === 0) return out;
      const rows = await currentDrizzleDb(db)
        .select({ id: treeNodes.id, trashedAt: treeNodes.trashedAt })
        .from(treeNodes)
        .where(and(inArray(treeNodes.id, [...documentIds]), isNotNull(treeNodes.trashRecord)));
      for (const row of rows)
        out.set(row.id, {
          reason: "deleted",
          actor: null,
          time: (row.trashedAt as Date).toISOString(),
        });
      return out;
    },
  };
}
