/** useDraftReviewController — shared state machine for reviewing AI document drafts. */

import type { Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { type Dispatch, useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  type DraftReviewSelection,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  type InlineDraftReview,
  inlineReviewFromState,
  type ReviewToast,
} from "./draft-review-session";
import type { ReviewFocus } from "./review-model";
import {
  type BranchCommandOutcome,
  type CommandStart,
  useWorkBranchCommands,
  type WorkBranchCommands,
} from "./useWorkBranchCommands";

export type { DraftReviewSelection, InlineDraftReview, ReviewToast };

/** What the controller needs to know of a change: its identity and where to focus it. */
export type ReviewChangeTarget = ReviewFocus;

export type DraftReviewStateOwner = Readonly<{
  state: typeof EMPTY_DRAFT_REVIEW_STATE;
  dispatch: Dispatch<Parameters<typeof draftReviewReducer>[1]>;
}>;

export function useDraftReviewStateOwner(): DraftReviewStateOwner {
  const [state, dispatch] = useReducer(draftReviewReducer, EMPTY_DRAFT_REVIEW_STATE);
  return { state, dispatch };
}

/** The single review-runtime claim: the mounted editor a review card can scroll to, plus the selection it is showing. */
export type InlineReviewRuntime = {
  editor: Editor;
  documentId: string;
  itemKey: string;
};

export type DraftReviewController = {
  projectId: string;
  workId: string;
  /** Focused thread owning this review surface; threads Apply/Discard cache invalidation. */
  threadId: string | null;
  inlineReview: InlineDraftReview | null;
  /** The open review's room, once a read has resolved it (`inlineReview.roomName`). */
  reviewRoomName: string | null;
  reviewRoomError: boolean;
  /** Dispatch the normalized target through this review's Work authority. */
  commandChange: WorkBranchCommands["commandChange"];
  /** A command on this presented draft only. */
  /**
   * Every Apply and Discard control disables on this: a disposition is in
   * flight, or the Work is archived and its drafts are frozen (D30). Review
   * stays available on a frozen Work.
   */
  dispositionLocked: boolean;
  /**
   * A change's own Apply and Discard disable on this alone: a command on the
   * whole presented draft is in flight, or the Work is frozen. Clicks during
   * another change's command are accepted and queued.
   */
  changesLocked: boolean;
  /** The header's "Show changes". The editor paints from it (`useInlineReviewFocus`). */
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
  reportFocusedChange: (review: DraftReviewSelection, change: ReviewFocus) => void;
  /**
   * Focus one change: in the manuscript and in every list. `scroll` brings it
   * into view. `review` is the review the caller meant: a caller that waited
   * (a command's answer) may find another one open, and then nothing happens.
   */
  focusReviewChange: (
    review: DraftReviewSelection,
    change: ReviewChangeTarget,
    options?: { scroll?: boolean; instant?: boolean },
  ) => void;
  toast: ReviewToast | null;
  dismissToast: (id: number) => void;
  enterInlineReview: (documentId: string, itemKey: string) => void;
  exitInlineReview: () => void;
  exitReview: () => void;
  inlineReviewModelAvailable: (identity: string, documentId: string, itemKey: string) => void;
  /** The review editor reports when its body is (or stops being) the painted one. */
  setInlineReviewShown: (documentId: string, itemKey: string, shown: boolean) => void;
  /** Claim/release the single review-runtime slot. */
  registerInlineReviewRuntime: (runtime: InlineReviewRuntime) => void;
  releaseInlineReviewRuntime: (editor: Editor) => void;
  startDraft: (mode: "apply" | "discard", draft: DraftReviewSelection) => CommandStart;
  apply: (documentId: string, itemKey: string) => Promise<BranchCommandOutcome>;
  discard: (documentId: string, itemKey: string) => Promise<BranchCommandOutcome>;
  disposeDrafts: (
    mode: "apply" | "discard",
    drafts: readonly DraftReviewSelection[],
  ) => Promise<BranchCommandOutcome[]>;
};

export function useDraftReviewController({
  projectId,
  work,
  threadId = null,
  stateOwner,
}: {
  projectId: string;
  /** The Work whose drafts this surface reviews; null scopes nothing. */
  work: Work | null;
  threadId?: string | null;
  stateOwner: DraftReviewStateOwner;
}): DraftReviewController {
  const workId = work?.id ?? "";
  const queryClient = useQueryClient();
  const { state, dispatch } = stateOwner;
  const commands = useWorkBranchCommands({ projectId, work, threadId, surface: "editor" });
  const stateRef = useRef(state);
  const activeRef = useRef(true);
  const inlineRuntimeRef = useRef<InlineReviewRuntime | null>(null);
  stateRef.current = state;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const inlineReview = inlineReviewFromState(state);

  const dispositionLocked = commands.dispositionLocked;
  const changesLocked = commands.changesLocked;

  const enterInlineReview = useCallback(
    (documentId: string, itemKey: string) => {
      // The review opens on the newest proposal the caches know of, and a command
      // already in flight on this draft (sent from the strip or the Work page)
      // is its to show: it adopts the claim if it acted on that generation.
      dispatch({
        type: "enterInline",
        documentId,
        itemKey,
      });
    },
    [projectId, queryClient, workId],
  );

  const exitInlineReview = useCallback(() => {
    const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
    if (inline) {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workDraftMetadata(
          projectId,
          workId,
          inline.documentId,
          inline.itemKey,
        ),
      });
    }
    dispatch({ type: "exitInline" });
  }, [projectId, queryClient, workId]);

  const exitReview = useCallback(() => {
    dispatch({ type: "exitReview" });
  }, []);

  const inlineReviewModelAvailable = useCallback(
    (identity: string, documentId: string, itemKey: string) => {
      dispatch({ type: "inlineModelAvailable", identity, documentId, itemKey });
    },
    [],
  );

  const setInlineReviewShown = useCallback(
    (documentId: string, itemKey: string, shown: boolean) => {
      dispatch({ type: "inlineShown", documentId, itemKey, shown });
    },
    [],
  );

  const registerInlineReviewRuntime = useCallback((runtime: InlineReviewRuntime) => {
    inlineRuntimeRef.current = runtime;
  }, []);

  // Release is a no-op unless the caller still holds the claim: on a review
  // document switch the new editor may register before the old one's effect
  // cleanup runs, and that stale cleanup must not clear the fresh claim.
  const releaseInlineReviewRuntime = useCallback((editor: Editor) => {
    if (inlineRuntimeRef.current?.editor === editor) {
      inlineRuntimeRef.current = null;
    }
  }, []);

  const reportFocusedChange = useCallback((review: DraftReviewSelection, change: ReviewFocus) => {
    dispatch({
      type: "changeFocused",
      documentId: review.documentId,
      itemKey: review.itemKey,
      focus: { id: change.id, frame: change.frame },
    });
  }, []);

  const focusReviewChange = useCallback(
    (
      review: DraftReviewSelection,
      change: ReviewChangeTarget,
      options?: { scroll?: boolean; instant?: boolean },
    ) => {
      // The identity is checked before anything is touched: the open review, and
      // the editor showing it, are the ones this focus was meant for.
      const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
      if (inline?.documentId !== review.documentId || inline.itemKey !== review.itemKey) return;
      reportFocusedChange(review, change);
      const runtime = inlineRuntimeRef.current;
      if (
        !runtime ||
        runtime.documentId !== review.documentId ||
        runtime.itemKey !== review.itemKey ||
        runtime.editor.isDestroyed
      )
        return;
      runtime.editor.commands.setReviewActiveChange(change.id);
      if (options?.scroll)
        runtime.editor.commands.scrollReviewChangeIntoView(change.id, {
          instant: options.instant,
        });
    },
    [reportFocusedChange],
  );

  const setMarksVisible = useCallback((visible: boolean) => {
    dispatch({ type: "marksVisible", visible });
  }, []);

  const dismissToast = useCallback((id: number) => {
    dispatch({ type: "toastDismissed", id });
  }, []);

  const { disposeDrafts } = commands;
  const startDraft = useCallback(
    (mode: "apply" | "discard", draft: DraftReviewSelection) => {
      return commands.startDraft(mode, draft);
    },
    [commands],
  );
  const apply = useCallback(
    (documentId: string, itemKey: string) => startDraft("apply", { documentId, itemKey }).outcome,
    [startDraft],
  );
  const discard = useCallback(
    (documentId: string, itemKey: string) => startDraft("discard", { documentId, itemKey }).outcome,
    [startDraft],
  );

  return useMemo(
    () => ({
      projectId,
      workId,
      threadId,
      inlineReview,
      reviewRoomName: inlineReview?.roomName ?? null,
      reviewRoomError: inlineReview?.roomError ?? false,
      commandChange: commands.commandChange,
      dispositionLocked,
      changesLocked,
      marksVisible: state.marksVisible,
      setMarksVisible,
      focus: inlineReview?.focus ?? null,
      reportFocusedChange,
      focusReviewChange,
      toast: state.toast,
      dismissToast,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      setInlineReviewShown,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      startDraft,
      apply,
      discard,
      disposeDrafts,
    }),
    [
      commands.commandChange,
      projectId,
      workId,
      threadId,
      inlineReview,
      dispositionLocked,
      changesLocked,
      state.marksVisible,
      setMarksVisible,
      inlineReview?.focus,
      reportFocusedChange,
      focusReviewChange,
      state.toast,
      dismissToast,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      setInlineReviewShown,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      startDraft,
      apply,
      discard,
      disposeDrafts,
    ],
  );
}
