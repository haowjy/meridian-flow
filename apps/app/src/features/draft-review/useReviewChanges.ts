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
import { type ReviewChange, resolveFocusedChange } from "./review-changes";
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
  /**
   * The server closed the draft: nothing is left to review. This is its answer
   * (`itemClosed`) and nothing else, never how many changes the list shows.
   */
  finished: boolean;
  focus: (change: ReviewChange, options?: { scroll?: boolean }) => void;
  step: (direction: 1 | -1) => void;
};

export function useReviewChanges(
  controller: DraftReviewController,
  options?: { enabled?: boolean },
): ReviewChangesView {
  const { documentId, itemKey, changes, items, completing, finished, unlisted, status } =
    useOpenReviewChanges(controller, options);
  // The review owns the focus (class and operations); this only reads it.
  const focused = resolveFocusedChange(changes, controller.focus);
  const focusedIndex = focused ? changes.indexOf(focused) : -1;

  const review = useMemo(
    () => (documentId && itemKey ? { documentId, itemKey } : null),
    [documentId, itemKey],
  );
  const focus = useCallback(
    (change: ReviewChange, options?: { scroll?: boolean; instant?: boolean }) => {
      if (review) controller.focusReviewChange(review, change, options);
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
      focus(changes[to], { scroll: true });
    },
    [changes, focus, focusedIndex],
  );

  /**
   * After a command the writer lands on the next change in the manuscript, or the
   * one before it. A Discard jumps there: its draft's next generation replaces the
   * editor, and a smooth scroll would be cut off half way by that swap.
   */
  const settleFocus = useCallback(
    (change: ReviewChange, instant: boolean) => {
      if (focused && focused.classId !== change.classId) return;
      const at = changes.indexOf(change);
      const next = changes[at + 1] ?? changes[at - 1];
      if (next) focus(next, { scroll: true, instant });
    },
    [changes, focus, focused],
  );

  const run = useCallback(
    async (change: ReviewChange, mode: "apply" | "discard", instant: boolean) => {
      // Apply draft and Discard draft handle what has no per-change commands.
      if (change.target.kind === "display" || !review) return;
      settleFocus(change, instant);
      const outcome = await controller.commandChange(mode, review, change.target);
      // The change is back (or was updated): the writer returns to it, where its
      // reason is shown. Only in the review the command was sent from: the
      // writer may have opened another while it was in flight.
      if (outcome.kind === "change-refused" && outcome.code !== "gone") {
        controller.focusReviewChange(review, change, { scroll: true });
      }
    },
    [controller.commandChange, controller.focusReviewChange, review, settleFocus],
  );
  const apply = useCallback((change: ReviewChange) => run(change, "apply", false), [run]);
  const discard = useCallback((change: ReviewChange) => run(change, "discard", true), [run]);

  return {
    documentId,
    itemKey,
    status,
    // A draft the server closed has nothing to list, whatever a stale read still holds.
    items,
    focused,
    focusedIndex,

    locked: controller.changesLocked,
    completing,
    finished,
    unlisted,
    focus,
    step,
    apply,
    discard,
  };
}
