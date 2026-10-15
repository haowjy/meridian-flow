/**
 * The attribution read's server half (contract Q3): which AI edit parts are pending in an item's text
 * branch, as the item ranges the browser's classifier tests against the room, with the conversation each
 * belongs to; the project's user, who owns the browser clients; and the Undo-restoration links that only
 * tombstone text can prove (the browser's gc drops the text). Writer edits are never listed.
 */
import { restorationLinks } from "@meridian/agent-edit/diff";
import type { AttributionRestoration, DraftAttribution } from "@meridian/contracts/drafts";
import { createCollabYDoc } from "@meridian/prosemirror-schema";
import * as Y from "yjs";
import type { BranchStore } from "./branch-coordinator.js";
import type { DraftAttributionStore } from "./ports/draft-attribution-store.js";

const LINK_CACHE_SIZE = 64;

export function createDraftAttribution(
  store: DraftAttributionStore,
  branches: Pick<BranchStore, "getBranch">,
) {
  // The browser refetches whenever a change id moves, so the link pass is cached per branch state vector.
  const links = new Map<string, AttributionRestoration[]>();
  async function restorations(branchId: string): Promise<AttributionRestoration[]> {
    const branch = await branches.getBranch(branchId);
    if (!branch) return [];
    const key = `${branchId}:${Buffer.from(branch.stateVector).toString("base64")}`;
    const cached = links.get(key);
    if (cached) return cached;
    const doc = createCollabYDoc({ gc: false });
    try {
      Y.applyUpdate(doc, branch.state);
      const found = restorationLinks(doc).map((link) => [...link] as AttributionRestoration);
      links.set(key, found);
      if (links.size > LINK_CACHE_SIZE) links.delete(links.keys().next().value as string);
      return found;
    } finally {
      doc.destroy();
    }
  }
  return {
    /** The read for one item; a branchless item has no text and so no edits. */
    async forItem(item: {
      itemKey: string;
      draftBranchId: string | null;
    }): Promise<DraftAttribution> {
      const itemKey = item.itemKey as DraftAttribution["itemKey"];
      if (!item.draftBranchId) return { itemKey, userId: "", edits: [], restorations: [] };
      const [edits, userId, found] = await Promise.all([
        store.pendingAgentEdits(item.draftBranchId),
        store.projectUserId(item.draftBranchId),
        restorations(item.draftBranchId),
      ]);
      return { itemKey, userId: userId ?? "", edits, restorations: found };
    },
  };
}
export type DraftAttributionService = ReturnType<typeof createDraftAttribution>;
