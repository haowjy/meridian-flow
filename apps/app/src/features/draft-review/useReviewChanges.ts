/**
 * useReviewChanges — the open review's changes as the writer sees them: in
 * document order, with the one in focus, what failed on each, and the commands
 * that act on them. The header's stepper, the presented document's bar and expanded Work
 * rows all read this, so they cannot disagree about which changes exist.
 *
 * Takes the controller explicitly. A surface outside the presenting host's
 * boundary must pass the presented review's controller, never the ambient one.
 *
 * Retained presentation data is shared with listed surfaces; this binding adds
 * only the open review's focus, stepping and command behavior.
 */
import { useCallback, useMemo } from "react";
import type { DraftChangesView } from "./draft-changes";
import { type ReviewChange, resolveFocusedChange, targetOfChanges } from "./review-model";
import type { DraftReviewController } from "./useDraftReviewController";
import { useOpenReviewChanges } from "./useOpenReviewChanges";

/** The open review's model: a draft's changes plus the review's focus, stepping and completion. */
export type ReviewChangesView = DraftChangesView & {
  /** The focused change's place among `items`, or -1. */
  focusedIndex: number;
  /**
   * The last change's command is in flight (`"apply"` or `"discard"`): the
   * change is gone from the list, but nothing is finished until the server
   * answers. Surfaces say so honestly and offer no way on.
   */
  completing: "apply" | "discard" | null;
  /** The review has no differences left. */
  finished: boolean;
  focus: (change: ReviewChange) => void;
  step: (direction: 1 | -1) => void;
};

export function useReviewChanges(
  controller: DraftReviewController,
  options?: { enabled?: boolean },
): ReviewChangesView {
  const { documentId, itemKey, changes, items, completing, finished, status } =
    useOpenReviewChanges(controller, options);
  // Focus belongs to the review; this only resolves its group id.
  const focused = resolveFocusedChange(changes, controller.focus) ?? changes[0] ?? null;
  const focusedIndex = focused ? changes.indexOf(focused) : -1;

  const review = useMemo(
    () => (documentId && itemKey ? { documentId, itemKey } : null),
    [documentId, itemKey],
  );
  const focus = useCallback(
    (change: ReviewChange) => {
      if (review) controller.focusReviewChange(review, change);
    },
    [controller.focusReviewChange, review],
  );

  const step = useCallback(
    (direction: 1 | -1) => {
      if (changes.length === 0) return;
      const from = focusedIndex;
      const to =
        from < 0
          ? direction > 0
            ? 0
            : changes.length - 1
          : (from + direction + changes.length) % changes.length;
      focus(changes[to]);
    },
    [changes, focus, focusedIndex],
  );

  /** Focus the next group when a local action removes this one. */
  const settleFocus = useCallback(
    (change: ReviewChange) => {
      if (focused && focused.id !== change.id) return;
      const at = changes.indexOf(change);
      const next = changes[at + 1] ?? changes[at - 1];
      if (next) focus(next);
    },
    [changes, focus, focused],
  );

  const run = useCallback(
    async (change: ReviewChange, mode: "apply" | "discard") => {
      // Apply draft and Discard draft handle what has no per-change commands.
      if (!review) return;
      settleFocus(change);
      const outcome = await controller.commandChange(mode, review, targetOfChanges([change]));
      // The change is back: the writer returns to it. Only in the review the command was sent
      // from: the writer may have opened another while it was in flight.
      if (outcome.kind === "settled") controller.focusReviewChange(review, change);
    },
    [controller.commandChange, controller.focusReviewChange, review, settleFocus],
  );
  const apply = useCallback((change: ReviewChange) => run(change, "apply"), [run]);
  const discard = useCallback((change: ReviewChange) => run(change, "discard"), [run]);

  return {
    documentId,
    itemKey,
    status,
    items,
    focused,
    focusedIndex,

    locked: controller.dispositionLocked || completing === "discard" || status !== "ready",
    completing,
    finished,
    focus,
    step,
    apply,
    discard,
  };
}
