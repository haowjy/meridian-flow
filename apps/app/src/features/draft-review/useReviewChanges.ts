/**
 * useReviewChanges: the open review's changes as the writer sees them: in document order, with the one in
 * focus, what failed on each, and the commands that act on them. The header's stepper, the presented
 * document's bar and expanded Work rows all read this, so they cannot disagree about which changes exist.
 *
 * Takes the controller explicitly. A surface outside the presenting host's boundary must pass the
 * presented review's controller, never the ambient one.
 */
import { useCallback, useMemo } from "react";

import type { AppliedChange } from "@/client/query/draft-command-record";
import type { ReviewFileTarget } from "@/client/query/work-draft-files";
import { isSameChange } from "@/core/editor/extensions/inline-review";
import type { DraftChangesView } from "./draft-changes";
import type { ReviewFrame } from "./review-frame";
import type { ReviewChange } from "./review-model";
import type { EditorRef } from "./review-runtime";
import type { DraftReviewController } from "./useDraftReviewController";
import type { HeadlessDiscards } from "./useHeadlessDiscards";
import { useOpenReviewChanges } from "./useOpenReviewChanges";

/**
 * A review with no editor to author a Discard into (the phone's read-only one): a Discard is a headless
 * edit of the draft's room, its own history per Discard, and the view lists it as `discarded` with `undoDiscard`.
 */
export type HeadlessReview = {
  discards: HeadlessDiscards;
  file: ReviewFileTarget;
  roomName: string;
};

/** The open review's model: a draft's changes plus the review's focus and stepping. */
export type ReviewChangesView = Omit<DraftChangesView, "discard"> & {
  discard: (change: ReviewChange) => Promise<unknown>;
  /** The frame this view's rows were drawn from: what a whole-draft Apply carries. */
  frame: ReviewFrame | null;
  /** The applied entries in force: the manuscript stops painting the changes they name. */
  applied: readonly AppliedChange[];
  /** The focused change's place among `items`, or -1. */
  focusedIndex: number;
  focus: (change: ReviewChange, options?: { scroll?: boolean }) => void;
  step: (direction: 1 | -1) => void;
};

export function useReviewChanges(
  controller: DraftReviewController,
  /** `editor`: the editor this view is read in (or its surface), so a Discard is authored into its history. */
  options?: { enabled?: boolean; editor?: EditorRef | null; headless?: HeadlessReview },
): ReviewChangesView {
  const data = useOpenReviewChanges(controller, options);
  const headless = options?.headless;
  const surface = options?.editor ?? null;
  const { documentId, itemKey, items } = data;
  const focused = items.find((item) => item.change.id === controller.focus)?.change ?? null;
  const focusedIndex = focused ? items.findIndex((item) => item.change === focused) : -1;

  const review = useMemo(
    () => (documentId && itemKey ? { documentId, itemKey } : null),
    [documentId, itemKey],
  );
  const focus = useCallback(
    (change: ReviewChange, options?: { scroll?: boolean; instant?: boolean }) => {
      if (review) controller.focusReviewChange(review, change.id, options);
    },
    [controller.focusReviewChange, review],
  );

  const step = useCallback(
    (direction: 1 | -1) => {
      if (items.length === 0) return;
      const to =
        focusedIndex < 0
          ? direction > 0
            ? 0
            : items.length - 1
          : (focusedIndex + direction + items.length) % items.length;
      focus(items[to].change, { scroll: true });
    },
    [items, focus, focusedIndex],
  );

  /** After a command the writer lands on the next change in the manuscript, or the one before it. */
  const settleFocus = useCallback(
    (change: ReviewChange) => {
      if (focused && focused.id !== change.id) return;
      const at = items.findIndex((item) => item.change === change);
      const next = items[at + 1] ?? items[at - 1];
      if (next) focus(next.change, { scroll: true, instant: true });
    },
    [items, focus, focused],
  );

  const apply = useCallback(
    async (change: ReviewChange) => {
      if (!review) return;
      settleFocus(change);
      // A new document's one change is the whole draft.
      const outcome = data.wholeDocument
        ? await controller.apply(review.documentId, review.itemKey, change.frame)
        : await controller.applyOpenChange(change);
      // The change is back with its reason on it: the writer returns to it, in the review it was sent from.
      if (outcome.kind === "failed") focus(change, { scroll: true });
    },
    [controller.apply, controller.applyOpenChange, data.wholeDocument, review, settleFocus, focus],
  );
  const discard = useCallback(
    async (change: ReviewChange) => {
      if (!review) return;
      settleFocus(change);
      if (data.wholeDocument) {
        await controller.discard(review.documentId, review.itemKey, surface);
        return;
      }
      if (headless) {
        if (controller.changesLocked) return;
        headless.discards.discardChange(
          headless.file,
          change,
          items.findIndex((item) => isSameChange(change, item.change.id, item.change.pin)),
          headless.roomName,
        );
        return;
      }
      controller.discardOpenChange(change, surface);
    },
    [
      headless,
      items,
      controller.changesLocked,
      controller.discard,
      controller.discardOpenChange,
      data.wholeDocument,
      review,
      settleFocus,
      surface,
    ],
  );

  return {
    documentId,
    itemKey,
    status: data.status,
    frame: data.frame,
    items,
    wholeDocument: data.wholeDocument,
    focused,
    focusedIndex,
    locked: controller.changesLocked,
    completing: data.completing,
    applied: data.applied,
    finished: data.finished,
    focus,
    step,
    apply,
    discard,
    ...(headless
      ? {
          discarded: headless.discards.entries.filter(
            (entry) => entry.file.draft.itemKey === itemKey && entry.change,
          ),
          undoDiscard: headless.discards.undo,
        }
      : {}),
  };
}
