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
import { getInlineReviewPluginState } from "@/core/editor/extensions/inline-review";
import { inlineReviewFocusIntent } from "@/core/editor/extensions/inline-review/DraftInlineReviewExtension";
import { useDraftReview } from "@/features/draft-review/DraftReviewProvider";
import { useArrivedChanges } from "@/features/draft-review/useArrivedChanges";
import { useReviewChanges } from "@/features/draft-review/useReviewChanges";

export function useInlineReviewFocus({
  editor,
  documentId,
  draftId,
}: {
  editor: Editor | null;
  documentId: string;
  draftId: string;
}): void {
  const { controller } = useDraftReview();
  const view = useReviewChanges(controller);
  const { reportFocusedChange, marksVisible } = controller;

  const live = editor && !editor.isDestroyed ? editor : null;
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
    if (!live || !reviewing) return;
    const onTransaction = ({
      transaction,
    }: {
      transaction: Parameters<typeof inlineReviewFocusIntent>[0];
    }) => {
      const operationId = inlineReviewFocusIntent(transaction);
      if (!operationId) return;
      const change = view.items.find(({ change }) => change.markKeys.includes(operationId))?.change;
      if (change) reportFocusedChange({ documentId, draftId }, change);
    };
    live.on("transaction", onTransaction);
    return () => {
      live.off("transaction", onTransaction);
    };
  }, [live, reviewing, documentId, draftId, reportFocusedChange, view.items]);

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
