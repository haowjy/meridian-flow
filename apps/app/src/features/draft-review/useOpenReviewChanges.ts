/**
 * Open review rows, without command or focus ownership: the item's pending move (its tree line)
 * when it has one, then its text changes. A delete replaces the text rows:
 * its banner and single document row are the review. Focus and stepping walk the visible text
 * changes (`changes`) alone; a tree line has no place in the text.
 */
import { useOwnerDraftList } from "@/client/query/useOwnerDrafts";
import type { DraftChangesData } from "./draft-changes";
import { useDraftCommandState } from "./draft-changes";
import type { DraftItemRef } from "./draft-review-session";
import { itemChange, type ReviewChange } from "./review-model";
import { treeChange, treeLineOf } from "./tree-line";
import type { DraftReviewController } from "./useDraftReviewController";

type ReviewRead = {
  status: "idle" | "ready";
  changes: readonly ReviewChange[];
};

/**
 * The open review's text changes. Drafts of a document's text are off for now: a document only
 * the Work holds is its one change, and any other has none.
 */
function useTextChanges(
  draft: (DraftItemRef & { projectId: string; draftId: string }) | null,
): ReviewRead {
  const listed = useOwnerDraftList(draft?.projectId ?? "", draft?.draftId ?? "", Boolean(draft));
  const item = draft ? listed.data?.items.find((row) => row.itemKey === draft.itemKey) : undefined;
  return { status: draft ? "ready" : "idle", changes: item?.wholeItem ? [itemChange(item)] : [] };
}

export function useOpenReviewChanges(
  controller: Pick<DraftReviewController, "projectId" | "draftId" | "inlineReview">,
  options?: { enabled?: boolean },
) {
  const inline = options?.enabled === false ? null : controller.inlineReview;
  const draft = inline
    ? {
        projectId: controller.projectId,
        draftId: controller.draftId,
        documentId: inline.documentId,
        itemKey: inline.itemKey,
      }
    : null;
  const command = useDraftCommandState(draft?.itemKey ?? "");
  const listed = useOwnerDraftList(controller.projectId, controller.draftId, Boolean(draft));
  const item = draft ? listed.data?.items.find((row) => row.itemKey === draft.itemKey) : undefined;
  const withoutText = item?.pending === false || item?.tree?.deleted === true;
  const read = useTextChanges(draft);
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
    items,
    status: withoutText ? "ready" : (read.status as DraftChangesData["status"]),
    completing: command.applying
      ? ("apply" as const)
      : command.hidden
        ? ("discard" as const)
        : null,
    // A listed new file is still its own change once its text is gone: Apply draft creates it.
    finished: read.status === "ready" && !items.length && !item?.isNew && !command.hidden,
  };
}
