/**
 * Open review rows are the room runtime's group projection, without command or focus ownership,
 * after the item's pending move (its tree line) when it has one. A delete replaces the text rows:
 * its banner and single document row are the review. Focus and stepping walk the visible text
 * changes (`changes`) alone; a tree line has no place in the text.
 */
import { useQuery } from "@tanstack/react-query";
import { workBranchDraftsQueryOptions } from "@/client/query/useWorkBranchDrafts";
import type { DraftChangesData } from "./draft-changes";
import { useChangeItems, useDraftCommandState } from "./draft-changes";
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
  const command = useDraftCommandState(draft?.itemKey ?? "");
  const listed = useQuery({
    ...workBranchDraftsQueryOptions(controller.projectId, controller.workId),
    enabled: Boolean(draft),
  });
  const item = draft ? listed.data?.find((row) => row.itemKey === draft.itemKey) : undefined;
  const withoutText = item?.hasDraft === false || item?.tree?.deleted === true;
  const read = useRoomReview(withoutText ? null : draft);
  const changes = read.changes;
  const { items } = useChangeItems(draft, changes);
  const status = withoutText ? "ready" : (read.status as DraftChangesData["status"]);
  return {
    inline,
    documentId: inline?.documentId ?? null,
    itemKey: inline?.itemKey ?? null,
    changes,
    retry: read.retry,
    items,
    status,

    completing: command.discarding
      ? ("discard" as const)
      : command.applying
        ? ("apply" as const)
        : null,
    finished: status === "ready" && !items.length && !command.pending && !command.discarding,
  };
}
