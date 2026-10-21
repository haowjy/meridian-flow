/** Open review rows are the room runtime's group projection, without command or focus ownership. */
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
  const read = useRoomReview(draft);
  const command = useDraftCommandState(draft?.itemKey ?? "");
  const { items } = useChangeItems(draft, read.changes);
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
