/** useDraftReviewController — the shared state machine for reviewing a draft's items. */

import type { Work } from "@meridian/contracts/works";
import { type Dispatch, useCallback, useMemo, useReducer, useRef } from "react";
import type { CommandOutcome } from "./draft-command-owner";
import {
  type DraftItemRef,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  type InlineDraftReview,
  inlineReviewFromState,
} from "./draft-review-session";
import type { ReviewFocus } from "./review-model";
import { type CommandStart, usePressCommands, type WorkDraftCommands } from "./usePressCommands";

export type { DraftItemRef, InlineDraftReview };

/** What the controller needs to know of a change: its identity and where to focus it. */
type ReviewChangeTarget = ReviewFocus;

type DraftReviewStateOwner = Readonly<{
  state: typeof EMPTY_DRAFT_REVIEW_STATE;
  dispatch: Dispatch<Parameters<typeof draftReviewReducer>[1]>;
}>;

export function useDraftReviewStateOwner(): DraftReviewStateOwner {
  const [state, dispatch] = useReducer(draftReviewReducer, EMPTY_DRAFT_REVIEW_STATE);
  return { state, dispatch };
}

export type DraftReviewController = {
  projectId: string;
  draftId: string;
  /** Focused thread owning this review surface; threads Apply/Discard cache invalidation. */
  threadId: string | null;
  inlineReview: InlineDraftReview | null;
  /** Dispatch the normalized target through this review's Work authority. */
  commandChange: WorkDraftCommands["commandChange"];
  /** A command on this presented draft only. */
  /**
   * Every Apply and Discard control disables on this: there is no owner to press on, or no
   * command driver yet. Clicks during another change's command are accepted and queued.
   */
  dispositionLocked: boolean;
  /** The presented tab's "Show changes" (`view.showChanges`). The editor paints from it (`useInlineReviewFocus`). */
  marksVisible: boolean;
  setMarksVisible: (visible: boolean) => void;
  /**
   * The change the writer is looking at in the open review, with the operations
   * it held, or null. Read it through `resolveFocusedChange`.
   */
  focus: ReviewFocus | null;
  /**
   * Record the change the focus is on without touching the manuscript: the
   * editor reporting a click, and the review keeping the focus current when the
   * server regroups the change. Ignored unless `review` is the open review.
   */
  reportFocusedChange: (review: DraftItemRef, change: ReviewFocus) => void;
  /**
   * Focus one change in every list. `review` is the review the caller meant: a caller that
   * waited (a command's answer) may find another one open, and then nothing happens.
   */
  focusReviewChange: (review: DraftItemRef, change: ReviewChangeTarget) => void;
  enterInlineReview: (documentId: string, itemKey: string) => void;
  exitInlineReview: () => void;
  exitReview: () => void;
  /** The review editor reports when its body is (or stops being) the painted one. */
  setInlineReviewShown: (documentId: string, itemKey: string, shown: boolean) => void;
  startItem: (mode: "apply" | "discard", item: DraftItemRef) => CommandStart;
  apply: (documentId: string, itemKey: string) => Promise<CommandOutcome>;
  discard: (documentId: string, itemKey: string) => Promise<CommandOutcome>;
};

export function useDraftReviewController({
  projectId,
  work,
  draftId,
  threadId = null,
  stateOwner,
  marks,
}: {
  projectId: string;
  /** The Work the draft belongs to, if any. */
  work: Work | null;
  /** The draft this surface reviews; "" scopes nothing. */
  draftId: string;
  threadId?: string | null;
  stateOwner: DraftReviewStateOwner;
  /** Show changes, which belongs to the presented tab's view, not to this review. */
  marks: { visible: boolean; set: (visible: boolean) => void };
}): DraftReviewController {
  const { state, dispatch } = stateOwner;
  const stateRef = useRef(state);
  const commands = usePressCommands({
    projectId,
    work,
    draftId,
    threadId,
    surface: "band",
  });
  stateRef.current = state;

  const inlineReview = inlineReviewFromState(state);

  const dispositionLocked = commands.dispositionLocked;

  const enterInlineReview = useCallback(
    (documentId: string, itemKey: string) => {
      dispatch({ type: "enterInline", documentId, itemKey });
    },
    [dispatch],
  );

  const exitInlineReview = useCallback(() => {
    dispatch({ type: "exitInline" });
  }, [dispatch]);

  const exitReview = useCallback(() => {
    dispatch({ type: "exitReview" });
  }, []);

  const setInlineReviewShown = useCallback(
    (documentId: string, itemKey: string, shown: boolean) => {
      dispatch({ type: "inlineShown", documentId, itemKey, shown });
    },
    [],
  );

  const reportFocusedChange = useCallback((review: DraftItemRef, change: ReviewFocus) => {
    dispatch({
      type: "changeFocused",
      documentId: review.documentId,
      itemKey: review.itemKey,
      focus: { id: change.id },
    });
  }, []);

  const focusReviewChange = useCallback(
    (review: DraftItemRef, change: ReviewChangeTarget) => {
      // The identity is checked before anything is touched: the open review is the one this
      // focus was meant for.
      const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
      if (inline?.documentId !== review.documentId || inline.itemKey !== review.itemKey) return;
      reportFocusedChange(review, change);
    },
    [reportFocusedChange],
  );

  const { startItem, apply, discard } = commands;

  return useMemo(
    () => ({
      projectId,
      draftId,
      threadId,
      inlineReview,
      commandChange: commands.commandChange,
      dispositionLocked,
      marksVisible: marks.visible,
      setMarksVisible: marks.set,
      focus: inlineReview?.focus ?? null,
      reportFocusedChange,
      focusReviewChange,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      setInlineReviewShown,
      startItem,
      apply,
      discard,
    }),
    [
      commands.commandChange,
      projectId,
      draftId,
      threadId,
      inlineReview,
      dispositionLocked,
      marks.visible,
      marks.set,
      inlineReview?.focus,
      reportFocusedChange,
      focusReviewChange,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      setInlineReviewShown,
      startItem,
      apply,
      discard,
    ],
  );
}
