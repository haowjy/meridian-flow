/**
 * The attribution read's server half (contract Q3): which AI edit parts are pending in an item's text
 * branch, as the item ranges the browser's classifier tests against the room, with the conversation each
 * belongs to, and the project's user, who owns the browser clients. Writer edits are never listed.
 */
import type { DraftAttribution } from "@meridian/contracts/drafts";
import type { DraftAttributionStore } from "./ports/draft-attribution-store.js";

export function createDraftAttribution(store: DraftAttributionStore) {
  return {
    /** The read for one item; a branchless item has no text and so no edits. */
    async forItem(item: {
      itemKey: string;
      draftBranchId: string | null;
    }): Promise<DraftAttribution> {
      const itemKey = item.itemKey as DraftAttribution["itemKey"];
      if (!item.draftBranchId) return { itemKey, userId: "", edits: [] };
      const [edits, userId] = await Promise.all([
        store.pendingAgentEdits(item.draftBranchId),
        store.projectUserId(item.draftBranchId),
      ]);
      return { itemKey, userId: userId ?? "", edits };
    },
  };
}
export type DraftAttributionService = ReturnType<typeof createDraftAttribution>;
