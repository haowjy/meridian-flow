/**
 * The attribution read's server half (contract Q3): which AI edit parts are pending in an item's text
 * branch, as the item ranges the browser's classifier tests against the room, with the conversation each
 * belongs to, and the project's user, who owns the browser clients. Writer edits are never listed.
 */
import type { DraftAttribution } from "@meridian/contracts/drafts";
import * as Y from "yjs";
import type { DraftAttributionStore } from "./ports/draft-attribution-store.js";

export function createDraftAttribution(store: DraftAttributionStore) {
  return {
    /** The read for one item; a branchless item has no text and so no edits. */
    async forItem(item: {
      itemKey: string;
      draftBranchId: string | null;
    }): Promise<DraftAttribution | null> {
      const itemKey = item.itemKey as DraftAttribution["itemKey"];
      if (!item.draftBranchId)
        return { itemKey, userId: "", edits: [], revision: [...Y.encodeSnapshot(Y.emptySnapshot)] };
      const read = await store.read(item.draftBranchId);
      if (!read) return null;
      const snapshot = Y.createSnapshot(
        Y.decodeUpdate(read.state).ds,
        Y.decodeStateVector(Y.encodeStateVectorFromUpdate(read.state)),
      );
      return {
        itemKey,
        userId: read.userId ?? "",
        edits: read.edits,
        revision: [...Y.encodeSnapshot(snapshot)],
      };
    },
  };
}
export type DraftAttributionService = ReturnType<typeof createDraftAttribution>;
