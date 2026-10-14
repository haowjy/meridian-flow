/**
 * The attribution hint's server half (contract Q3): which chats have AI edit parts pending in an
 * item's text branch, as the item ranges the browser's matcher tests against the room. A hint for
 * naming chats on changes; nothing gates on it, and writer edits are never listed.
 */
import type { DraftAttribution } from "@meridian/contracts/drafts";
import type { DraftAttributionStore } from "./ports/draft-attribution-store.js";

export function createDraftAttribution(store: DraftAttributionStore) {
  return {
    /** The hint for one item; a branchless item has no text and so no edits. */
    async forItem(item: {
      itemKey: string;
      draftBranchId: string | null;
    }): Promise<DraftAttribution> {
      return {
        itemKey: item.itemKey as DraftAttribution["itemKey"],
        edits: item.draftBranchId ? await store.pendingAgentEdits(item.draftBranchId) : [],
      };
    },
  };
}
export type DraftAttributionService = ReturnType<typeof createDraftAttribution>;
