/** useDraftReviewController — shared state machine for reviewing AI document branches. */

import type { Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { type Dispatch, useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  type BranchCommandOutcome,
  type CommandStart,
  newestKnownProposal,
  type SelectionCommand,
} from "@/client/query/branch-command-executor";
import {
  clearDraftReviewLaunchFailure,
  pendingBranchCommand,
  useBranchCommandRecords,
} from "@/client/query/branch-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { noteReviewNavigation } from "@/core/editor/review-place";
import {
  type DraftReviewSelection,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  type InlineDraftReview,
  inlineReviewFromState,
  type ReviewToast,
} from "./draft-review-session";
import type { ReviewFocus } from "./review-changes";
import { draftClaim, useReviewCommandCompletion } from "./useReviewCommandCompletion";
import { useWorkBranchCommands, type WorkBranchCommands } from "./useWorkBranchCommands";

export type { DraftReviewSelection, InlineDraftReview, ReviewToast };

/** What the controller needs to know of a change: its identity and where to focus it. */
export type ReviewChangeTarget = ReviewFocus & { anchorOperationId: string };

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
  isApplying: boolean;
  canApplyReviewedDraft: boolean;
  /** Dispatch the normalized target through this review's Work authority. */
  commandChange: WorkBranchCommands["commandChange"];
  /** A command on this presented draft only. */
  isDisposing: boolean;
  /**
   * Every Apply and Discard control disables on this: a disposition is in
   * flight, or the Work is archived and its branches are frozen (D30). Review
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
  /**
   * Apply or Discard a selection of changes of any draft of this Work. The
   * changes leave every surface at once. Every review of the addressed draft
   * observes completion; callers never select the reviewing controller as
   * executor.
   */
  applyChanges: SelectionCommand;
  discardChanges: SelectionCommand;
  toast: ReviewToast | null;
  dismissToast: (id: number) => void;
  enterInlineReview: (documentId: string, itemKey: string) => void;
  /**
   * The editor's room reports it is of a generation the server has closed
   * (`draft-generation-stale`). The review asks for a fresh read and keeps its
   * place; it neither exits nor guesses the new room.
   */
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
  disposeBranches: (
    mode: "apply" | "discard",
    branches: readonly DraftReviewSelection[],
  ) => Promise<BranchCommandOutcome[]>;
};

export function useDraftReviewController({
  projectId,
  work,
  threadId = null,
  stateOwner,
}: {
  projectId: string;
  /** The Work whose branches this surface reviews; null scopes nothing. */
  work: Work | null;
  threadId?: string | null;
  stateOwner: DraftReviewStateOwner;
}): DraftReviewController {
  const workId = work?.id ?? "";
  const queryClient = useQueryClient();
  const { state, dispatch } = stateOwner;
  const commands = useWorkBranchCommands({ projectId, work, threadId });
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

  const commandRecords = useBranchCommandRecords();
  const activeCommand = inlineReview
    ? pendingBranchCommand(commandRecords, { projectId, workId, ...inlineReview })
    : null;
  const isApplying = activeCommand?.target === "all" && activeCommand.mode === "apply";
  const isDisposing = activeCommand !== null;
  const dispositionLocked = commands.dispositionLocked || isDisposing;
  const changesLocked = commands.changesLocked || activeCommand?.target === "all";
  const canApplyReviewedDraft =
    state.surface.kind === "inline" && state.surface.previewIdentity !== undefined;

  const enterInlineReview = useCallback(
    (documentId: string, itemKey: string) => {
      const draft = { projectId, workId, documentId, itemKey };
      clearDraftReviewLaunchFailure(draft);
      // The review opens on the newest proposal the caches know of, and a command
      // already in flight on this draft (sent from the strip or the Work page)
      // is its to show: it adopts the claim if it acted on that generation.
      dispatch({
        type: "enterInline",
        documentId,
        itemKey,
        draftGeneration: newestKnownProposal(queryClient, draft),
        claim: draftClaim(queryClient, draft),
      });
    },
    [projectId, queryClient, workId],
  );

  const exitInlineReview = useCallback(() => {
    const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
    if (inline) {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workBranchPreview(
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
      focus: { classId: change.classId, operationIds: change.operationIds, keys: change.keys },
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
      // The writer chose where to go: a place held across an editor swap yields to it.
      if (options?.scroll)
        noteReviewNavigation(`${review.documentId}:${review.itemKey}`, change.keys ?? []);
      const runtime = inlineRuntimeRef.current;
      if (
        !runtime ||
        runtime.documentId !== review.documentId ||
        runtime.itemKey !== review.itemKey ||
        runtime.editor.isDestroyed
      )
        return;
      runtime.editor.commands.setInlineReviewActiveOperation(change.anchorOperationId);
      if (options?.scroll)
        runtime.editor.commands.scrollInlineReviewOperationIntoView(change.anchorOperationId, {
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

  useReviewCommandCompletion({ projectId, workId, activeRef, stateRef, dispatch });

  const { applyChanges, discardChanges, disposeBranches } = commands;
  const startDraft = useCallback(
    (mode: "apply" | "discard", draft: DraftReviewSelection) => {
      const generation = newestKnownProposal(queryClient, { projectId, workId, ...draft });
      const start = commands.startDraft(mode, draft);
      return {
        ...start,
        outcome: start.outcome.then((outcome) => {
          if (outcome.kind === "applied" || outcome.kind === "discarded")
            dispatch({ type: "reviewDisposed", ...draft, draftGeneration: generation });
          return outcome;
        }),
      };
    },
    [commands.startDraft, queryClient, projectId, workId, dispatch],
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
      isApplying,
      canApplyReviewedDraft,
      commandChange: commands.commandChange,
      isDisposing,
      dispositionLocked,
      changesLocked,
      marksVisible: state.marksVisible,
      setMarksVisible,
      focus: inlineReview?.focus ?? null,
      reportFocusedChange,
      focusReviewChange,
      applyChanges,
      discardChanges,
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
      disposeBranches,
    }),
    [
      commands.commandChange,
      projectId,
      workId,
      threadId,
      inlineReview,
      isApplying,
      canApplyReviewedDraft,
      isDisposing,
      dispositionLocked,
      changesLocked,
      state.marksVisible,
      setMarksVisible,
      inlineReview?.focus,
      reportFocusedChange,
      focusReviewChange,
      applyChanges,
      discardChanges,
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
      disposeBranches,
    ],
  );
}
