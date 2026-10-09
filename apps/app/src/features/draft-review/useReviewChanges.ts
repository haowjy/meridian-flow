/**
 * useReviewChanges — the open review's changes as the writer sees them: in
 * document order, with the one in focus, what failed on each, and the commands
 * that act on them. The header's stepper, the manuscript's bar and the dock's
 * list all read this, so they cannot disagree about which changes exist.
 *
 * Takes the controller explicitly. The review lives in the Editor's scope, and
 * the dock sits in the Chat's: a surface outside the Editor must pass the
 * Editor scope's controller, never the ambient one.
 *
 * A change the writer has applied or discarded is already gone from the
 * preview this reads (`useDraftPreview`), and a change that failed is back with
 * its reason.
 */
import { useCallback, useMemo } from "react";

import { useDraftPreview } from "@/client/query/useDraftPreview";
import { selectionOf } from "./change-selection";
import { type DraftChangesView, listablePreview, useChangeItems } from "./draft-changes";
import {
  adoptsGeneration,
  type DraftCommandOutcome,
  type DraftReviewSelection,
} from "./draft-review-session";
import { type ReviewChange, resolveFocusedChange, reviewChangesOfPreview } from "./review-changes";
import type { DraftReviewController } from "./useDraftReviewController";

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
   * (`draftClosed`) and nothing else, never how many changes the list shows.
   */
  finished: boolean;
  focus: (change: ReviewChange, options?: { scroll?: boolean }) => void;
  step: (direction: 1 | -1) => void;
};

const NO_ITEMS: ReviewChangesView["items"] = [];
const NO_CHANGES: readonly ReviewChange[] = [];

/** The open review's draft and its changes, derived once per preview. */
export function useOpenReviewChanges(
  controller: DraftReviewController,
  options?: { enabled?: boolean },
) {
  // A warm editor that is not the one in review reads nothing.
  const inline = options?.enabled === false ? null : controller.inlineReview;
  const documentId = inline?.documentId ?? null;
  const draftId = inline?.draftId ?? null;
  const { preview } = useDraftPreview(
    controller.projectId,
    controller.workId,
    documentId,
    draftId,
    {
      enabled: inline !== null,
    },
  );
  const active = listablePreview(preview);
  // The review lists the changes of the generation it shows. A preview of
  // another one is the next proposal on its way in (the review re-enters it) or
  // the close's own reset: it is not this review's to list.
  const shown = inline?.draftGeneration;
  const changes =
    active && (shown === undefined || active.draftGeneration === shown)
      ? reviewChangesOfPreview(active)
      : NO_CHANGES;
  return { inline, documentId, draftId, preview, active, changes };
}

export function useReviewChanges(
  controller: DraftReviewController,
  options?: { enabled?: boolean },
): ReviewChangesView {
  const { inline, documentId, draftId, preview, active, changes } = useOpenReviewChanges(
    controller,
    options,
  );
  const draftRef = useMemo(
    () =>
      documentId && draftId
        ? { projectId: controller.projectId, workId: controller.workId, documentId, draftId }
        : null,
    [controller.projectId, controller.workId, documentId, draftId],
  );
  const { items, hiding } = useChangeItems(draftRef, changes);

  // The review owns the focus (class and operations); this only reads it.
  const focused = resolveFocusedChange(changes, controller.focus);
  const focusedIndex = focused ? changes.indexOf(focused) : -1;

  const review = useMemo(
    () => (documentId && draftId ? { documentId, draftId } : null),
    [documentId, draftId],
  );
  const focus = useCallback(
    (change: ReviewChange, options?: { scroll?: boolean }) => {
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

  /** After a command the writer lands on the next change in the manuscript, or the one before it. */
  const settleFocus = useCallback(
    (change: ReviewChange) => {
      if (focused && focused.classId !== change.classId) return;
      const at = changes.indexOf(change);
      const next = changes[at + 1] ?? changes[at - 1];
      if (next) focus(next, { scroll: true });
    },
    [changes, focus, focused],
  );

  const run = useCallback(
    async (
      change: ReviewChange,
      command: (
        review: DraftReviewSelection,
        selection: ReturnType<typeof selectionOf>,
      ) => Promise<DraftCommandOutcome>,
    ) => {
      // Apply draft and Discard draft handle what has no per-change commands.
      if (!change.actionable || !review) return;
      settleFocus(change);
      const outcome = await command(review, selectionOf([change]));
      // The change is back (or was updated): the writer returns to it, where its
      // reason is shown. Only in the review the command was sent from: the
      // writer may have opened another while it was in flight.
      if (outcome.kind === "change-refused" && outcome.code !== "gone") {
        controller.focusReviewChange(review, change, { scroll: true });
      }
    },
    [controller.focusReviewChange, review, settleFocus],
  );
  const apply = useCallback(
    (change: ReviewChange) => run(change, controller.applyChanges),
    [controller.applyChanges, run],
  );
  const discard = useCallback(
    (change: ReviewChange) => run(change, controller.discardChanges),
    [controller.discardChanges, run],
  );

  const completion = inline?.completion;
  const completing = completion?.phase === "pending" ? completion.mode : null;
  const status: ReviewChangesView["status"] = !inline
    ? "idle"
    : active
      ? adoptsGeneration(inline, {
          draftGeneration: active.draftGeneration,
          proposal: active.inlineModelPresent && reviewChangesOfPreview(active).length > 0,
        })
        ? "loading"
        : "ready"
      : preview?.status === "gone"
        ? "gone"
        : "loading";
  const finished = completion?.phase === "closed";
  const unlisted =
    !finished && status === "ready" && completing === null && items.length === 0 && !hiding;

  return {
    documentId,
    draftId,
    status,
    // A draft the server closed has nothing to list, whatever a stale read still holds.
    items: completion?.phase === "closed" ? NO_ITEMS : items,
    focused,
    focusedIndex,
    canApply: active?.isNewDocument !== true,
    locked: controller.dispositionLocked,
    completing,
    finished,
    unlisted,
    focus,
    step,
    apply,
    discard,
  };
}
