/** Keeps one projected group focused; a missing group falls back to the first remaining change. */
import { useEffect, useRef } from "react";
import type { PresentedDocument } from "@/features/project/presented-document";
import { resolveFocusedChange } from "./review-model";
import type { DraftReviewController } from "./useDraftReviewController";
import { useOpenReviewChanges } from "./useOpenReviewChanges";

export function useReconcileReviewFocus(
  controller: DraftReviewController,
  presented?: PresentedDocument | null,
): void {
  const { documentId, itemKey, changes, status } = useOpenReviewChanges(controller);
  const { focus, reportFocusedChange } = controller;
  const restored = useRef<string | null>(null);
  useEffect(() => {
    if (!documentId || !itemKey) {
      restored.current = null;
      return;
    }
    const identity = `${documentId}:${itemKey}`;
    if (restored.current !== identity) {
      if (status !== "ready") return;
      restored.current = identity;
      if (presented?.review?.itemKey === itemKey && presented.review.changeId && !focus) {
        // A missing projection-local group falls back silently.
        const change = changes.find((item) => item.id === presented.review?.changeId) ?? changes[0];
        if (change) controller.focusReviewChange({ documentId, itemKey }, change);
        return;
      }
    }
    const resolved = resolveFocusedChange(changes, focus) ?? changes[0];
    if (!resolved) return;
    reportFocusedChange({ documentId, itemKey }, resolved);
  }, [
    changes,
    focus,
    documentId,
    itemKey,
    reportFocusedChange,
    presented,
    status,
    controller.focusReviewChange,
  ]);
}
