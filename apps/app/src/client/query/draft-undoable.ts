/** draft-undoable — shared expiry rule for server-backed draft undo affordances. */
import { DRAFT_UNDO_RETENTION_MS, type ThreadDraftListItem } from "@meridian/contracts/drafts";

export function isDraftUndoable(draft: ThreadDraftListItem, nowMs = Date.now()): boolean {
  if (draft.status === "active") return false;
  const updatedAtMs = Date.parse(draft.updatedAt);
  return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs <= DRAFT_UNDO_RETENTION_MS;
}
