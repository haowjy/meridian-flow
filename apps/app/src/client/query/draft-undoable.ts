/** draft-undoable — shared expiry rule for server-backed draft undo affordances. */
import { DRAFT_UNDO_RETENTION_MS, type ThreadDraftListItem } from "@meridian/contracts/drafts";

export function isDraftUndoable(draft: ThreadDraftListItem, nowMs = Date.now()): boolean {
  if (draft.status !== "closed") return false;
  const closedAt = draft.appliedAt ?? draft.discardedAt;
  const closedAtMs = closedAt ? Date.parse(closedAt) : NaN;
  return Number.isFinite(closedAtMs) && nowMs - closedAtMs <= DRAFT_UNDO_RETENTION_MS;
}
