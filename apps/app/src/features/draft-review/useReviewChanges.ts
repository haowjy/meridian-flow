/**
 * useReviewChanges — the open review's changes as the writer sees them: in
 * document order, with the one in focus, what failed on each, and the commands
 * that act on them. The header's stepper, the presented document's bar and expanded Work
 * rows all read this, so they cannot disagree about which changes exist.
 *
 * Takes the controller explicitly. A surface outside the presenting host's
 * boundary must pass the presented review's controller, never the ambient one.
 *
 * A change the writer has applied or discarded is already gone from the
 * preview this reads (`useDraftPreview`), and a change that failed is back with
 * its reason.
 */
import { useCallback, useMemo, useRef } from "react";
import type { DraftCommandOutcome } from "@/client/query/draft-command-executor";

import { useDraftPreview } from "@/client/query/useDraftPreview";
import { selectionOf } from "./change-selection";
import { type DraftChangesView, listablePreview, useChangeItems } from "./draft-changes";
import { adoptsGeneration, type DraftReviewSelection } from "./draft-review-session";
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
  // A surface outside the open review reads nothing.
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
  const own =
    active && (shown === undefined || active.draftGeneration === shown)
      ? reviewChangesOfPreview(active)
      : null;
  // While the review and its preview disagree about the generation (the next
  // one is arriving, or the cache lags behind it), the list the writer was
  // acting on stays and its rows keep taking clicks; each click is resolved
  // against the draft as it is when it is sent. Only the draft's own earlier
  // list is kept, never another draft's.
  const held = useRef<{ draftId: string | null; changes: readonly ReviewChange[] }>({
    draftId: null,
    changes: NO_CHANGES,
  });
  if (own) held.current = { draftId, changes: own };
  // A newer preview with nothing to review is the close's own reset: that is not held.
  const keeping =
    own === null &&
    active !== null &&
    held.current.draftId === draftId &&
    shown !== undefined &&
    (active.draftGeneration < shown || reviewChangesOfPreview(active).length > 0);
  const changes = own ?? (keeping ? held.current.changes : NO_CHANGES);
  const settling = keeping && changes.length > 0;
  return { inline, documentId, draftId, preview, active, changes, settling };
}

export function useReviewChanges(
  controller: DraftReviewController,
  options?: { enabled?: boolean },
): ReviewChangesView {
  const { inline, documentId, draftId, preview, active, changes, settling } = useOpenReviewChanges(
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

  /**
   * After a command the focus moves to the next change, or the one before it.
   * An Apply carries the viewport there. A Discard leaves it where it is: the
   * draft's next generation replaces the editor, and the writer's place is
   * kept across that (`review-place`).
   */
  const settleFocus = useCallback(
    (change: ReviewChange, scroll: boolean) => {
      if (focused && focused.classId !== change.classId) return;
      const at = changes.indexOf(change);
      const next = changes[at + 1] ?? changes[at - 1];
      if (next) focus(next, { scroll });
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
      scroll: boolean,
    ) => {
      // Apply draft and Discard draft handle what has no per-change commands.
      if (!change.actionable || !review) return;
      settleFocus(change, scroll);
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
    async (change: ReviewChange) => {
      if (change.wholeDraft && review) await controller.apply(review.documentId, review.draftId);
      else await run(change, controller.applyChanges, true);
    },
    [controller.apply, controller.applyChanges, review, run],
  );
  const discard = useCallback(
    async (change: ReviewChange) => {
      if (change.wholeDraft && review) await controller.discard(review.documentId, review.draftId);
      else await run(change, controller.discardChanges, false);
    },
    [controller.discard, controller.discardChanges, review, run],
  );

  const completion = inline?.completion;
  const completing = completion?.phase === "pending" ? completion.mode : null;
  const status: ReviewChangesView["status"] = !inline
    ? "idle"
    : active
      ? adoptsGeneration(inline, {
          draftGeneration: active.draftGeneration,
          proposal: reviewChangesOfPreview(active).length > 0,
        }) && !settling
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
