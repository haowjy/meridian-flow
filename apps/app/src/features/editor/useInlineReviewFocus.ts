/**
 * useInlineReviewFocus — keeps the manuscript's marks and the review's state
 * saying the same thing, in both directions:
 *
 *   controller → editor   Show changes on/off, the focused change's emphasis,
 *                         the pulse on changes that just arrived
 *   editor → controller   a click on a mark (or a struck removal) focuses that
 *                         change everywhere: the list, the stepper, the bar
 *
 * The companion to `useInlineReviewSync`, which pushes the server model. Only
 * the review editor mounts it; the plugin state is the guard.
 */
import type { Editor } from "@tiptap/core";
import { useEffect, useMemo } from "react";

import {
  getInlineReviewPluginState,
  isUnattributedHunkKey,
} from "@/core/editor/extensions/inline-review";
import { useDraftReview } from "@/features/chat/DraftReviewProvider";
import { useArrivedChanges } from "@/features/draft-review/useArrivedChanges";
import { useReviewChanges } from "@/features/draft-review/useReviewChanges";

export function useInlineReviewFocus({
  editor,
  enabled,
  documentId,
  draftId,
}: {
  editor: Editor | null;
  enabled: boolean;
  documentId: string;
  draftId: string | null;
}): void {
  const { controller } = useDraftReview();
  const inThisReview =
    enabled &&
    controller.inlineReview?.documentId === documentId &&
    controller.inlineReview.draftId === draftId;
  const view = useReviewChanges(controller, { enabled: inThisReview });
  const { reportFocusedChange, marksVisible } = controller;

  const live = editor && !editor.isDestroyed && enabled ? editor : null;
  const reviewing = live !== null && getInlineReviewPluginState(live.state) !== null;

  // Show changes.
  useEffect(() => {
    if (!live || !reviewing) return;
    if (getInlineReviewPluginState(live.state)?.marksVisible === marksVisible) return;
    live.commands.setInlineReviewMarksVisible(marksVisible);
  }, [live, reviewing, marksVisible]);

  // The focused change's emphasis.
  const anchor = view.focused?.anchorOperationId ?? null;
  useEffect(() => {
    if (!live || !reviewing) return;
    if (getInlineReviewPluginState(live.state)?.activeOperationId === anchor) return;
    live.commands.setInlineReviewActiveOperation(anchor);
  }, [live, reviewing, anchor]);

  // A click on a mark focuses its change. Reports the change the active mark
  // belongs to now, not only a new active mark: the server regrouping a class
  // moves the mark's change without moving the mark.
  useEffect(() => {
    if (!live || !reviewing || !draftId) return;
    let reportedOperationId: string | null = null;
    let reportedModel: unknown = null;
    const onTransaction = () => {
      const state = getInlineReviewPluginState(live.state);
      const operationId = state?.activeOperationId ?? null;
      const model = state?.model ?? null;
      if (operationId === reportedOperationId && model === reportedModel) return;
      reportedOperationId = operationId;
      reportedModel = model;
      if (!operationId) return;
      // An unclassified hunk has no operation: its key is also its change's id.
      const classId = isUnattributedHunkKey(operationId)
        ? operationId
        : model?.operations.find((operation) => operation.operationId === operationId)
            ?.closureClassId;
      if (!classId) return;
      const operationIds = isUnattributedHunkKey(operationId)
        ? []
        : (model?.operations ?? [])
            .filter((operation) => operation.closureClassId === classId)
            .map((operation) => operation.operationId);
      reportFocusedChange({ documentId, draftId }, { classId, operationIds });
    };
    live.on("transaction", onTransaction);
    return () => {
      live.off("transaction", onTransaction);
    };
  }, [live, reviewing, documentId, draftId, reportFocusedChange]);

  // Changes that arrive while the writer reviews pulse once.
  const changes = useMemo(() => view.items.map((item) => item.change), [view.items]);
  const arrived = useArrivedChanges(
    changes,
    view.status === "ready",
    view.documentId && view.draftId ? `${view.documentId}:${view.draftId}` : null,
  );
  const pulsed = useMemo(
    () =>
      changes.filter((change) => arrived.has(change.classId)).flatMap((change) => change.markKeys),
    [changes, arrived],
  );
  useEffect(() => {
    if (!live || !reviewing) return;
    live.commands.setInlineReviewPulse(pulsed);
  }, [live, reviewing, pulsed]);
}
