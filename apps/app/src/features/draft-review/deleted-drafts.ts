/**
 * Drafts whose document live deleted (D79): the draft keeps it, and Apply brings it back
 * before merging.
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
