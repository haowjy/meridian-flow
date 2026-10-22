/**
 * Drafts whose document live deleted (D79): the draft keeps it, and Apply brings it back
 * before merging. A taken path holds Apply until the writer renames the other document.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/branches";

/**
 * Deleted from the manuscript, and Apply can bring it back: a draft or a drafted move does
 * (at the branch's location), a drafted delete never does, so Apply all's confirmation never
 * names one.
 */
export function isDeletedFromManuscript(item: ThreadDraftListItem | null | undefined): boolean {
  return item?.deletedLive === true && !item.tree?.deleted;
}

/** Another document holds the item's path, so Apply can't succeed until it moves. */
export function isPathTaken(item: ThreadDraftListItem | null | undefined): boolean {
  return item?.conflict?.code === "path_taken";
}

/**
 * A group's Apply all (Work Files, the chat dock) is withdrawn while any of its documents has a
 * taken path: Apply all means every listed document, never all but the ones it can't apply.
 */
export function isGroupApplyWithdrawn(items: Iterable<ThreadDraftListItem>): boolean {
  for (const item of items) if (isPathTaken(item)) return true;
  return false;
}
