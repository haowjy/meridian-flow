/**
 * Removal's collab half: every removal registers its documents with the retirement batch, so
 * their live rooms close `4208`; only a discard closes their drafts.
 */
import type { WorkId } from "@meridian/contracts";
import type { Database } from "@meridian/database";
import { branches } from "@meridian/database/schema";
import { inArray } from "drizzle-orm";
import { currentDrizzleDb } from "../../../shared/drizzle-transaction.js";
import type { DocumentRemovalCollab } from "../../context/ports/document-removal.js";
import type { DraftClose } from "./drizzle-draft-close.js";

export function createDrizzleDocumentRemovalCollab(
  db: Database,
  close: Pick<DraftClose, "closeDrafts" | "registerRemoved">,
): DocumentRemovalCollab {
  return {
    registerRemoved: (documentIds, record) => close.registerRemoved(documentIds, record),
    async closeDiscardedDrafts(documentIds, record) {
      const tx = currentDrizzleDb(db);
      const closed = await close.closeDrafts(tx, { documentIds }, { documentRemoved: record });
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
