/** Re-derive focus when a new projection invalidates the previous address. */
import { useEffect } from "react";
import { resolveFocusedChange } from "./review-model";
import type { DraftReviewController } from "./useDraftReviewController";
import { useOpenReviewChanges } from "./useOpenReviewChanges";

export function useReconcileReviewFocus(controller: DraftReviewController): void {
  const { documentId, itemKey, changes } = useOpenReviewChanges(controller);
  const { focus, reportFocusedChange } = controller;
  useEffect(() => {
    if (!documentId || !itemKey) return;
    const resolved = resolveFocusedChange(changes, focus) ?? changes[0];
    if (resolved) reportFocusedChange({ documentId, itemKey }, resolved);
  }, [changes, focus, documentId, itemKey, reportFocusedChange]);
}
