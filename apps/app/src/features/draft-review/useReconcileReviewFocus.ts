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
import { useEffect, useRef } from "react";
import type { PresentedDocument } from "@/features/project/presented-document";
import { resolveFocusedChange } from "./review-changes";
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
        // Stable part-key classes survive reload; a handled class falls back silently.
        const change =
          changes.find((item) => item.classId === presented.review?.changeId) ?? changes[0];
        if (change) controller.focusReviewChange({ documentId, itemKey }, change);
        return;
      }
    }
    const resolved = resolveFocusedChange(changes, focus);
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
