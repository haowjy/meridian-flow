/**
 * Drafts whose document live deleted (D79): the draft keeps it, and Apply brings it back
 * before merging. A taken path holds Apply until the writer renames the other document.
 */
import type { ThreadDraftListItem } from "@meridian/contracts/branches";

/** Deleted from the manuscript, and Apply can bring it back. */
export function isDeletedFromManuscript(item: ThreadDraftListItem | null | undefined): boolean {
  return item?.conflict?.code === "deleted_live";
}

/** Another document holds the item's path, so Apply can't succeed until it moves. */
export function isPathTaken(item: ThreadDraftListItem | null | undefined): boolean {
  return item?.conflict?.code === "path_taken";
}
