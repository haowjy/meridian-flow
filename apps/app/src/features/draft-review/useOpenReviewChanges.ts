/** The open review's changes, read from the review state of its draft, without focus or command bindings. */
import { useMemo } from "react";
import type { AppliedChange, DraftRef } from "@/client/query/draft-command-record";
import { type DraftChangesData, type ReviewChangeItem, useChangeItems } from "./draft-changes";
import type { ReviewFrame } from "./review-frame";
import type { ReviewChange } from "./review-model";
import type { DraftReviewController } from "./useDraftReviewController";

const NO_ITEMS: readonly ReviewChangeItem[] = [];
const NO_CHANGES: readonly ReviewChange[] = [];

/** The open review's draft and its changes, derived once per frame. */
export function useOpenReviewChanges(
  controller: Pick<DraftReviewController, "projectId" | "workId" | "inlineReview" | "wholeItem">,
  options?: { enabled?: boolean },
): DraftChangesData & {
  changes: readonly ReviewChange[];
  frame: ReviewFrame | null;
  /** The applied entries in force: the manuscript stops painting the changes they name at the click. */
  applied: readonly AppliedChange[];
} {
  // A surface outside the open review reads nothing.
  const inline = options?.enabled === false ? null : controller.inlineReview;
  const documentId = inline?.documentId ?? null;
  const itemKey = inline?.itemKey ?? null;
  const draftRef = useMemo<DraftRef | null>(
    () =>
      documentId && itemKey
        ? { projectId: controller.projectId, workId: controller.workId, documentId, itemKey }
        : null,
    [controller.projectId, controller.workId, documentId, itemKey],
  );
  const { items, changes, frame, ready, applied, completing } = useChangeItems(draftRef, {
    wholeDocument: controller.wholeItem,
  });
  const status: DraftChangesData["status"] = !inline
    ? "idle"
    : inline.roomError
      ? "error"
      : ready
        ? "ready"
        : "loading";
  return {
    documentId,
    itemKey,
    status,
    changes: status === "ready" ? changes : NO_CHANGES,
    frame,
    applied,
    items: status === "ready" ? items : NO_ITEMS,
    wholeDocument: controller.wholeItem,
    completing,
    finished: status === "ready" && items.length === 0 && completing === null,
  };
}
