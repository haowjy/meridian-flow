/**
 * useReconcileReviewFocus: keeps the review's focus naming a change that exists.
 *
 * The focus (`controller.focus`) is one group id for the whole review. A group id is a content hash, so it
 * changes when the change's text does (the AI extends it, the writer types inside it). When the focused id
 * is no longer listed, focus follows the writer's caret to the change it sits in, else lets go. A launch
 * that named a change (`presented.review.changeId`) is applied once, when the review is ready.
 */
import { useEffect, useRef } from "react";
import { currentReview, getInlineReviewPluginState } from "@/core/editor/extensions/inline-review";
import type { PresentedDocument } from "@/features/project/presented-document";
import { reviewRuntimeOf } from "./review-runtime";
import type { DraftReviewController } from "./useDraftReviewController";
import { useReviewState } from "./useReviewRuntime";

export function useReconcileReviewFocus(
  controller: DraftReviewController,
  presented?: PresentedDocument | null,
): void {
  const documentId = controller.inlineReview?.documentId;
  const itemKey = controller.inlineReview?.itemKey;
  const { focus, reportFocusedChange, projectId, workId } = controller;
  const draft = documentId && itemKey ? { projectId, workId, documentId, itemKey } : null;
  const { ready, focusExists } = useReviewState(draft, (state) => ({
    ready: state.ready && !controller.inlineReview?.roomError,
    focusExists: !focus || state.changes.some((change) => change.id === focus),
  }));
  const restored = useRef<string | null>(null);
  useEffect(() => {
    if (!documentId || !itemKey) {
      restored.current = null;
      return;
    }
    const review = { documentId, itemKey };
    const identity = `${documentId}:${itemKey}`;
    if (restored.current !== identity) {
      if (!ready) return;
      restored.current = identity;
      if (presented?.review?.itemKey === itemKey && presented.review.changeId && !focus) {
        // Ids are content hashes; a handled or edited change falls back to the first silently.
        const changes =
          reviewRuntimeOf({ projectId, workId, documentId, itemKey })?.state().changes ?? [];
        const change = changes.find((item) => item.id === presented.review?.changeId) ?? changes[0];
        if (change) controller.focusReviewChange(review, change.id);
        return;
      }
    }
    if (!ready || !focus || focusExists) return;
    // The caret and the painted marks share the editor's coordinates; the chrome's frame may be behind them.
    const editor = reviewRuntimeOf({ projectId, workId, documentId, itemKey })?.editorHandle()
      ?.editor;
    const live = editor && !editor.isDestroyed ? editor : null;
    const painted = live ? getInlineReviewPluginState(live.state) : null;
    const reviewAtCaret = painted ? currentReview(painted) : null;
    const caret = live?.state.selection.head;
    const here =
      caret === undefined || !reviewAtCaret
        ? null
        : reviewAtCaret.groups.find((group) =>
            group.hunks.some((hunk) =>
              (hunk.formatContext?.inserted ?? (hunk.inserted ? [hunk.inserted] : [])).some(
                (range) => caret >= range.from && caret <= range.to,
              ),
            ),
          );
    reportFocusedChange(review, here?.id ?? null);
  }, [
    focusExists,
    focus,
    documentId,
    itemKey,
    reportFocusedChange,
    presented,
    ready,
    projectId,
    workId,
    controller.focusReviewChange,
  ]);
}
