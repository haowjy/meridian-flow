/**
 * Open review rows are the room runtime's group projection, without command or focus ownership,
 * after the item's pending move or delete (its tree line) when it has one: a review isn't done
 * while its document is still being renamed, moved or deleted. Focus and stepping walk the text
 * changes (`changes`) alone; the tree line has no place in the text.
 */
import { useQuery } from "@tanstack/react-query";
import { workBranchDraftsQueryOptions } from "@/client/query/useWorkBranchDrafts";
import type { DraftChangesData } from "./draft-changes";
import { useChangeItems, useDraftCommandState } from "./draft-changes";
import { treeChange, treeLineOf } from "./tree-line";
import type { DraftReviewController } from "./useDraftReviewController";
import { useRoomReview } from "./useRoomReview";
export function useOpenReviewChanges(
  controller: Pick<DraftReviewController, "projectId" | "workId" | "inlineReview">,
  options?: { enabled?: boolean },
) {
  const inline = options?.enabled === false ? null : controller.inlineReview;
  const draft = inline
    ? {
        projectId: controller.projectId,
        workId: controller.workId,
        documentId: inline.documentId,
        itemKey: inline.itemKey,
      }
    : null;
  const read = useRoomReview(draft);
  const command = useDraftCommandState(draft?.itemKey ?? "");
  const listed = useQuery({
    ...workBranchDraftsQueryOptions(controller.projectId, controller.workId),
    enabled: Boolean(draft),
  });
  const item = draft ? listed.data?.find((row) => row.itemKey === draft.itemKey) : undefined;
  const line = item && !item.isNew ? treeLineOf(item) : null;
  const { items } = useChangeItems(
    draft,
    item && line ? [treeChange(item, line), ...read.changes] : read.changes,
  );
  return {
    inline,
    documentId: inline?.documentId ?? null,
    itemKey: inline?.itemKey ?? null,
    changes: read.changes,
    retry: read.retry,
    items,
    status: read.status as DraftChangesData["status"],

    completing: command.discarding
      ? ("discard" as const)
      : command.applying
        ? ("apply" as const)
        : null,
    finished: read.status === "ready" && !items.length && !command.pending && !command.discarding,
  };
}
