/**
 * The attribution read's server half (contract Q3): which AI edit parts are pending in an item's text
 * branch, as the item ranges the browser's classifier tests against the room, with the conversation each
 * belongs to, and the project's user, who owns the browser clients. Writer edits are never listed.
 */
import type { DraftAttribution } from "@meridian/contracts/drafts";
import * as Y from "yjs";
import type { BranchCoordinator } from "./branch-coordinator.js";
import type { DraftAttributionStore } from "./ports/draft-attribution-store.js";

export function createDraftAttribution(
  store: DraftAttributionStore,
  branches: Pick<BranchCoordinator, "readBranch">,
) {
  return {
    /** The read for one item; a branchless item has no text and so no edits. */
    async forItem(item: {
      itemKey: string;
      draftBranchId: string | null;
    }): Promise<DraftAttribution> {
      const itemKey = item.itemKey as DraftAttribution["itemKey"];
      if (!item.draftBranchId)
        return { itemKey, userId: "", edits: [], revision: [...Y.encodeSnapshot(Y.emptySnapshot)] };
      const branchId = item.draftBranchId;
      return branches.readBranch(branchId, async (doc) => {
        const revision = [...Y.encodeSnapshot(Y.snapshot(doc))];
        const [edits, userId] = await Promise.all([
          store.pendingAgentEdits(branchId),
          store.projectUserId(branchId),
        ]);
        return { itemKey, userId: userId ?? "", edits, revision };
      });
    },
  };
}
export type DraftAttributionService = ReturnType<typeof createDraftAttribution>;
