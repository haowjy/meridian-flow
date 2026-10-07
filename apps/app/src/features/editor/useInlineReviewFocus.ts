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
  const { reportFocusedClass, marksVisible } = controller;

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

  // A click on a mark focuses its change.
  useEffect(() => {
    if (!live || !reviewing || !draftId) return;
    let reported: string | null = null;
    const onTransaction = () => {
      const state = getInlineReviewPluginState(live.state);
      const operationId = state?.activeOperationId ?? null;
      if (operationId === reported) return;
      reported = operationId;
      if (!operationId) return;
      // An unclassified hunk has no operation: its key is also its change's id.
      const classId = isUnattributedHunkKey(operationId)
        ? operationId
        : state?.model?.operations.find((operation) => operation.operationId === operationId)
            ?.closureClassId;
      if (classId) reportFocusedClass(documentId, draftId, classId);
    };
    live.on("transaction", onTransaction);
    return () => {
      live.off("transaction", onTransaction);
    };
  }, [live, reviewing, documentId, draftId, reportFocusedClass]);

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
