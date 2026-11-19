/**
 * Open review rows are the room runtime's group projection, without command or focus ownership,
 * after the item's pending move (its tree line) when it has one. A delete replaces the text rows:
 * its banner and single document row are the review. Focus and stepping walk the visible text
 * changes (`changes`) alone; a tree line has no place in the text.
 */
import { useOwnerDraftList } from "@/client/query/useOwnerDrafts";
import type { DraftChangesData } from "./draft-changes";
import { useDraftCommandState } from "./draft-changes";
import { treeChange, treeLineOf } from "./tree-line";
import type { DraftReviewController } from "./useDraftReviewController";
import { useRoomReview } from "./useRoomReview";
export function useOpenReviewChanges(
  controller: Pick<DraftReviewController, "projectId" | "ownerKey" | "inlineReview">,
  options?: { enabled?: boolean },
) {
  const inline = options?.enabled === false ? null : controller.inlineReview;
  const draft = inline
    ? {
        projectId: controller.projectId,
        ownerKey: controller.ownerKey,
        documentId: inline.documentId,
        itemKey: inline.itemKey,
      }
    : null;
  const command = useDraftCommandState(draft?.itemKey ?? "");
  const listed = useOwnerDraftList(controller.projectId, controller.ownerKey, Boolean(draft));
  const item = draft ? listed.data?.items.find((row) => row.itemKey === draft.itemKey) : undefined;
  const withoutText = item?.hasDraft === false || item?.tree?.deleted === true;
  const read = useRoomReview(draft);
  const line = item && !item.isNew ? treeLineOf(item) : null;
  const changes = line?.kind === "delete" ? [] : read.changes;
  const items = (item && line ? [treeChange(item, line), ...changes] : changes).map((change) => ({
    change,
  }));
  return {
    inline,
    documentId: inline?.documentId ?? null,
    itemKey: inline?.itemKey ?? null,
    changes,
    retry: read.retry,
    items,
    // A draft gone while on screen has nothing to act on.
    status: command.ended
      ? "gone"
      : withoutText
        ? "ready"
        : (read.status as DraftChangesData["status"]),

    completing: command.discarding
      ? ("discard" as const)
      : command.applying
        ? ("apply" as const)
        : null,
    // A listed new file is still its own change once its text is gone: Apply draft creates it.
    finished:
      read.status === "ready" &&
      !items.length &&
      !item?.isNew &&
      !command.pending &&
      !command.discarding,
  };
}
