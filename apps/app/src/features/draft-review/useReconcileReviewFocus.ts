/**
 * useReconcileReviewFocus — keeps the review's focus naming the change the
 * writer was looking at when the server regroups it.
 *
 * The focus (`controller.focus`) is one value for the whole review: a class and
 * the operations it held. When a fresh preview no longer lists that class but
 * lists a change that shares one of its operations, that change is the same
 * one, and the focus is moved onto it here, once. Every surface then reads the
 * same focus through `resolveFocusedChange`, whether it was mounted before the
 * regrouping or after. Mounted by the review's owner (`useDraftReviewScopeValue`),
 * never by a reader.
 */
import { useEffect } from "react";

import type { DraftReviewController } from "@/features/chat/useDraftReviewController";
import { resolveFocusedChange } from "./review-changes";
import { useOpenReviewChanges } from "./useReviewChanges";

export function useReconcileReviewFocus(controller: DraftReviewController): void {
  const { documentId, draftId, changes } = useOpenReviewChanges(controller);
  const { focus, reportFocusedChange } = controller;
  useEffect(() => {
    if (!documentId || !draftId) return;
    const resolved = resolveFocusedChange(changes, focus);
    if (!resolved) return;
    reportFocusedChange({ documentId, draftId }, resolved);
  }, [changes, focus, documentId, draftId, reportFocusedChange]);
}
