/**
 * useInlineReviewFocus: keeps the manuscript's marks and the review's state saying the same thing, in both
 * directions:
 *
 *   controller to editor   Show changes on/off, the focused change's emphasis, the pulse on changes that
 *                          just arrived
 *   editor to controller   a click on a mark (or a struck removal) focuses that change everywhere: the
 *                          list, the stepper, the bar
 *
 * The companion to `useInlineReviewSync`, which hands the editor to the review runtime. Only the review editor mounts
 * it; the plugin state is the guard.
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
  itemKey,
}: {
  editor: Editor | null;
  documentId: string;
  itemKey: string;
}): void {
  const { controller } = useDraftReview();
  const view = useReviewChanges(controller);
  const {
    reportFocusedChange,
    marksVisible,
    registerInlineReviewRuntime,
    releaseInlineReviewRuntime,
  } = controller;

  const live = editor && !editor.isDestroyed ? editor : null;
  const reviewing = live !== null && getInlineReviewPluginState(live.state) !== null;

  useEffect(() => {
    if (!live || !reviewing) return;
    registerInlineReviewRuntime({ editor: live, documentId, itemKey });
    return () => releaseInlineReviewRuntime(live);
  }, [
    live,
    reviewing,
    documentId,
    itemKey,
    registerInlineReviewRuntime,
    releaseInlineReviewRuntime,
  ]);

  // Show changes.
  useEffect(() => {
    if (!live || !reviewing) return;
    if (getInlineReviewPluginState(live.state)?.marksVisible === marksVisible) return;
    live.commands.setReviewMarksVisible(marksVisible);
  }, [live, reviewing, marksVisible]);

  // The focused change's emphasis.
  const active = view.focused?.id ?? null;
  const activeProjection = view.focused?.frame?.diff;
  useEffect(() => {
    if (!live || !reviewing) return;
    if (getInlineReviewPluginState(live.state)?.activeChangeId === active) return;
    live.commands.setReviewActiveChange(active);
  }, [live, reviewing, active, activeProjection]);

  // A click on a mark focuses its change.
  useEffect(() => {
    if (!live || !reviewing) return;
    const onTransaction = ({
      transaction,
    }: {
      transaction: Parameters<typeof inlineReviewFocusIntent>[0];
    }) => {
      const changeId = inlineReviewFocusIntent(transaction);
      const frame = getInlineReviewPluginState(live.state)?.review;
      if (changeId && frame) reportFocusedChange({ documentId, itemKey }, { id: changeId, frame });
    };
    live.on("transaction", onTransaction);
    return () => {
      live.off("transaction", onTransaction);
    };
  }, [live, reviewing, documentId, itemKey, reportFocusedChange]);

  // Changes that arrive while the writer reviews pulse once.
  const changes = useMemo(() => view.items.map((item) => item.change), [view.items]);
  const arrived = useArrivedChanges(
    changes,
    view.status === "ready",
    view.documentId && view.itemKey ? `${view.documentId}:${view.itemKey}` : null,
  );
  const pulsed = useMemo(
    () => changes.filter((change) => arrived.has(change.id)).map((change) => change.id),
    [changes, arrived],
  );
  useEffect(() => {
    if (!live || !reviewing) return;
    const painted = getInlineReviewPluginState(live.state)?.pulsedChangeIds;
    if (painted?.size === pulsed.length && pulsed.every((id) => painted.has(id))) return;
    live.commands.setReviewPulse(pulsed);
  }, [live, reviewing, pulsed]);
}
