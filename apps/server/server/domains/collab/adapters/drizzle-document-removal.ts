/** Removal's collab half: every active draft on the removed documents closes as a removal. */
import type { WorkId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { branches } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentRemovalCollab } from "../../context/ports/document-removal.js";
import { collabHook } from "../domain/collab-test-hooks.js";
import type { DraftClose } from "./drizzle-draft-close.js";

export function createDrizzleDocumentRemovalCollab(
  db: Database,
  close: Pick<DraftClose, "closeDrafts">,
): DocumentRemovalCollab {
  return {
    async closeRemovedDocuments(documentIds, record) {
      const tx = currentDrizzleDb(db);
      const closed = await close.closeDrafts(tx, { documentIds }, { documentRemoved: record });
      await collabHook("removal.afterClose");
      const branchIds = [...new Set(closed.map((draft) => draft.branchId))];
      if (!branchIds.length) return [];
      const owners = await tx
        .select({ workId: branches.originWorkId })
        .from(branches)
        .where(inArray(branches.id, branchIds));
      return owners.flatMap(({ workId }) => (workId ? [workId as WorkId] : []));
    },
  };
}
