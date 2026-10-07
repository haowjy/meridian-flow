/** useDraftReviewController — shared state machine for reviewing AI document drafts. */

import type { DraftPreviewResponse, ThreadDraftListItem } from "@meridian/contracts/drafts";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import {
  type Dispatch,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { getDraftPreview } from "@/client/api/drafts-api";
import { type ChangeRef, markDraftCleared } from "@/client/query/change-command-record";
import {
  clearDraftCommandFailure,
  draftCommandPendingIn,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  DraftApplyOutcomeUnknownError,
  settleConfirmedChange,
  useApplyDraft,
  useApplyDraftChanges,
  useDiscardDraft,
} from "@/client/query/useDraftReviewMutations";
import { getContextTabs } from "@/client/stores";
import { reviewChanges } from "@/features/draft-review/review-changes";
import { useContextRemovalCoordinator } from "@/features/project/context/account-feature-context";
import { routeTargetForTab } from "@/features/project/context/context-removal-planner";
import {
  useIsCurrentContextRoute,
  useOpenContextRoute,
} from "@/features/project/routing/ProjectNavigationContext";
import {
  type DraftBatchErrorCode,
  type DraftCommandOutcome,
  type DraftReviewCommandPorts,
  type DraftReviewSelection,
  DraftReviewSession,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  type InlineDraftReview,
  type InlineReviewMessage,
  type InlineReviewMessageCode,
  inlineReviewFromState,
  type ReviewToast,
} from "./draft-review-session";

export type { DraftReviewSelection, InlineDraftReview, InlineReviewMessageCode, ReviewToast };

/** What the controller needs to know of a change: its identity and where to focus it. */
export type ReviewChangeTarget = ChangeRef & { anchorOperationId: string };

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
  draftId: string;
};

export type DraftReviewController = {
  projectId: string;
  workId: string;
  /** Focused thread owning this review surface; threads Apply/Discard cache invalidation. */
  threadId: string | null;
  inlineReview: InlineDraftReview | null;
  reviewRoomName: string | null;
  reviewRoomError: boolean;
  isApplying: boolean;
  isDiscarding: boolean;
  isPending: boolean;
  canApplyReviewedDraft: boolean;
  /**
   * The global disposition lock: any Apply/Discard in flight in the session.
   * Every mutating control disables on it so dispositions can't overlap.
   */
  isDisposing: boolean;
  /**
   * Every Apply and Discard control disables on this: a disposition is in
   * flight, or the Work is archived and its drafts are frozen (D30). Review
   * stays available on a frozen Work.
   */
  dispositionLocked: boolean;
  inlineReviewMessage: InlineReviewMessage | null;
  /** The header's "Show changes". The editor paints from it (`useInlineReviewFocus`). */
  marksVisible: boolean;
  setMarksVisible: (visible: boolean) => void;
  /** The change the writer is looking at in the open review, or null. */
  focusedClassId: string | null;
  /** The editor reports the change a click in the manuscript landed on. */
  reportFocusedClass: (documentId: string, draftId: string, classId: string | null) => void;
  /** Focus one change: in the manuscript and in every list. `scroll` brings it into view. */
  focusReviewChange: (change: ReviewChangeTarget, options?: { scroll?: boolean }) => void;
  /** Apply or Discard one change of the open review. It leaves every surface at once. */
  applyChange: (change: ChangeRef) => Promise<DraftCommandOutcome>;
  discardChange: (change: ChangeRef) => Promise<DraftCommandOutcome>;
  toast: ReviewToast | null;
  dismissToast: (id: number) => void;
  dockDispositionError: DraftBatchErrorCode | null;
  enterInlineReview: (documentId: string, draftId: string) => void;
  exitInlineReview: () => void;
  exitReview: () => void;
  inlineReviewModelAvailable: (identity: string, documentId: string, draftId: string) => void;
  /** The review editor reports when its body is (or stops being) the painted one. */
  setInlineReviewShown: (documentId: string, draftId: string, shown: boolean) => void;
  /** Claim/release the single review-runtime slot. */
  registerInlineReviewRuntime: (runtime: InlineReviewRuntime) => void;
  releaseInlineReviewRuntime: (editor: Editor) => void;
  apply: (documentId: string, draftId: string) => Promise<DraftCommandOutcome>;
  discard: (documentId: string, draftId: string) => Promise<DraftCommandOutcome>;
  disposeDrafts: (
    mode: "apply" | "discard",
    drafts: readonly DraftReviewSelection[],
  ) => Promise<DraftCommandOutcome[]>;
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
  stateOwner?: DraftReviewStateOwner;
}): DraftReviewController {
  const workId = work?.id ?? "";
  const draftsFrozen = work !== null && isWorkArchived(work);
  const queryClient = useQueryClient();
  const contextRemoval = useContextRemovalCoordinator();
  const openContextRoute = useOpenContextRoute();
  const isCurrentContextRoute = useIsCurrentContextRoute();
  const applyMutation = useApplyDraft();
  const applyChangesMutation = useApplyDraftChanges();
  const discardMutation = useDiscardDraft();
  const localStateOwner = useDraftReviewStateOwner();
  const { state, dispatch } = stateOwner ?? localStateOwner;
  const commandPortsRef = useRef<DraftReviewCommandPorts | null>(null);
  // One session per Work: the controller outlives navigation between Works, and
  // a command still in flight in the Work left behind must not keep the new
  // Work's controls disabled.
  const reviewSession = useMemo(
    () =>
      new DraftReviewSession(() => {
        const ports = commandPortsRef.current;
        if (!ports) throw new Error("Draft review command ports are not ready.");
        return ports;
      }),
    [projectId, workId],
  );
  const dispositionLock = reviewSession.disposition;
  const disposition = useSyncExternalStore(
    dispositionLock.subscribe,
    dispositionLock.getSnapshot,
    dispositionLock.getSnapshot,
  );
  const [reviewRoomName, setReviewRoomName] = useState<string | null>(null);
  const [reviewRoomError, setReviewRoomError] = useState(false);
  const stateRef = useRef(state);
  const activeRef = useRef(true);
  const inlineRuntimeRef = useRef<InlineReviewRuntime | null>(null);
  const activeReviewRequestRef = useRef<(DraftReviewSelection & { attemptId: number }) | null>(
    null,
  );
  const nextReviewAttemptIdRef = useRef(0);
  stateRef.current = state;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const inlineReview = inlineReviewFromState(state);
  const inlineReviewMessage = state.inlineReviewMessage;
  const dockDispositionError = state.dockDispositionError;

  const activeDisposition = disposition.busy ? disposition.target : null;
  const isApplying = activeDisposition?.kind === "apply-draft";
  const isDiscarding = activeDisposition?.kind === "discard-draft";
  const isPending = isApplying || isDiscarding;
  // A command in flight on any draft of this Work, from any surface, disables this one.
  const commandRecords = useDraftCommandRecords();
  const isDisposing =
    disposition.busy || draftCommandPendingIn(commandRecords, { projectId, workId });
  const dispositionLocked = isDisposing || draftsFrozen;
  const canApplyReviewedDraft =
    state.surface.kind === "inline" && state.surface.previewIdentity !== undefined;

  useEffect(() => {
    if (inlineReview) return;
    activeReviewRequestRef.current = null;
    setReviewRoomName(null);
    setReviewRoomError(false);
  }, [inlineReview]);

  const loadInlineReviewRoom = useCallback(
    (documentId: string, draftId: string) => {
      nextReviewAttemptIdRef.current += 1;
      const attemptId = nextReviewAttemptIdRef.current;
      activeReviewRequestRef.current = { documentId, draftId, attemptId };
      setReviewRoomName(null);
      setReviewRoomError(false);
      void getDraftPreview(projectId, workId, documentId, draftId)
        .then((preview) => {
          queryClient.setQueryData(
            projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId),
            preview,
          );
          const current = activeReviewRequestRef.current;
          if (
            current?.documentId !== documentId ||
            current.draftId !== draftId ||
            current.attemptId !== attemptId
          )
            return;
          if (preview.status === "active") setReviewRoomName(preview.reviewRoomName);
        })
        .catch(() => {
          const current = activeReviewRequestRef.current;
          if (
            current?.documentId !== documentId ||
            current.draftId !== draftId ||
            current.attemptId !== attemptId
          )
            return;
          void queryClient.invalidateQueries({
            queryKey: projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId),
          });
          setReviewRoomName(null);
          setReviewRoomError(true);
        });
    },
    [projectId, queryClient, workId],
  );

  async function settleConfirmedApply(
    tab: ReturnType<typeof getContextTabs>["tabs"][number] | undefined,
  ): Promise<void> {
    if (tab?.kind !== "tracked") return;
    try {
      if (tab.draftOnly) await contextRemoval.promoteAppliedDraft(projectId, tab);
      if (isCurrentContextRoute && openContextRoute) {
        const target = routeTargetForTab(tab, workId);
        if (isCurrentContextRoute(target)) {
          await openContextRoute(target, {
            replace: true,
            isCurrent: () => isCurrentContextRoute(target),
          });
        }
      }
    } catch {
      // Applied stays applied. A failed route repair is navigation's to show,
      // and the document host reconciles a tab that was not promoted.
    }
  }

  commandPortsRef.current = {
    scope: { projectId, workId },
    apply: async ({ documentId, draftId }) => {
      const tab = getContextTabs(projectId).tabs.find(
        (candidate) => candidate.documentId === documentId,
      );
      try {
        await applyMutation.mutateAsync({ projectId, workId, threadId, documentId, draftId });
      } catch (error) {
        if (error instanceof DraftApplyOutcomeUnknownError) return "unknown";
        throw error;
      }
      // Confirmed is terminal for the command: the batch advances now. Tab
      // promotion and the route repair are navigation's business and run on.
      void settleConfirmedApply(tab);
      return "applied";
    },
    discard: async ({ documentId, draftId }, input) => {
      await discardMutation.mutateAsync({
        projectId,
        workId,
        threadId,
        documentId,
        draftId,
        ...input,
      });
    },
    applyChanges: ({ documentId, draftId }, request) =>
      applyChangesMutation.mutateAsync({
        projectId,
        workId,
        threadId,
        documentId,
        draftId,
        request,
      }),
    changeConfirmed: ({ documentId, draftId }, change, mode) =>
      settleConfirmedChange(
        queryClient,
        { projectId, workId, threadId, documentId, draftId },
        change,
        mode,
      ),
    batchStarted: () => {
      dispatch({ type: "batchStarted" });
    },
    batchSettled: (error) => {
      dispatch({ type: "batchSettled", error });
    },
    // The tab closes with the click; a refusal leaves it closed and the error
    // on the draft (see draft-command-record).
    draftDiscardStarted: (selection) => {
      contextRemoval.discardDraft(projectId, workId, selection.documentId, selection.draftId);
    },
    draftApplied: ({ documentId, draftId }) => {
      dispatch({ type: "applySucceeded", documentId, draftId });
    },
    draftFailed: (selection, code) => {
      dispatch({ type: "draftCommandFailed", selection, code });
    },
    draftDiscarded: ({ documentId, draftId }) => {
      dispatch({ type: "discardSucceeded", draftId });
      contextRemoval.discardDraft(projectId, workId, documentId, draftId);
    },
  };

  const enterInlineReview = useCallback(
    (documentId: string, draftId: string) => {
      clearDraftCommandFailure({ projectId, workId, documentId, draftId });
      dispatch({ type: "enterInline", documentId, draftId });
      loadInlineReviewRoom(documentId, draftId);
    },
    [loadInlineReviewRoom, projectId, workId],
  );

  const exitInlineReview = useCallback(() => {
    const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
    if (inline) {
      void queryClient.invalidateQueries({
        queryKey: projectQueryKeys.workDraftPreview(
          projectId,
          workId,
          inline.documentId,
          inline.draftId,
        ),
      });
    }
    activeReviewRequestRef.current = null;
    setReviewRoomName(null);
    setReviewRoomError(false);
    dispatch({ type: "exitInline" });
  }, [projectId, queryClient, workId]);

  const exitReview = useCallback(() => {
    activeReviewRequestRef.current = null;
    setReviewRoomName(null);
    setReviewRoomError(false);
    dispatch({ type: "exitReview" });
  }, []);

  const inlineReviewModelAvailable = useCallback(
    (identity: string, documentId: string, draftId: string) => {
      dispatch({ type: "inlineModelAvailable", identity, documentId, draftId });
    },
    [],
  );

  const setInlineReviewShown = useCallback(
    (documentId: string, draftId: string, shown: boolean) => {
      dispatch({ type: "inlineShown", documentId, draftId, shown });
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

  const focusReviewChange = useCallback(
    (change: ReviewChangeTarget, options?: { scroll?: boolean }) => {
      const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
      if (!inline) return;
      dispatch({
        type: "changeFocused",
        documentId: inline.documentId,
        draftId: inline.draftId,
        classId: change.classId,
      });
      const editor = inlineRuntimeRef.current?.editor;
      if (!editor || editor.isDestroyed) return;
      editor.commands.setInlineReviewActiveOperation(change.anchorOperationId);
      if (options?.scroll)
        editor.commands.scrollInlineReviewOperationIntoView(change.anchorOperationId);
    },
    [],
  );

  const reportFocusedClass = useCallback(
    (documentId: string, draftId: string, classId: string | null) => {
      dispatch({ type: "changeFocused", documentId, draftId, classId });
    },
    [],
  );

  const setMarksVisible = useCallback((visible: boolean) => {
    dispatch({ type: "marksVisible", visible });
  }, []);

  const dismissToast = useCallback((id: number) => {
    dispatch({ type: "toastDismissed", id });
  }, []);

  /** Run one change command against the open review, and say what happened. */
  const runChangeCommand = useCallback(
    async (
      command: (
        inline: DraftReviewSelection,
        previewTokens: { liveRevisionToken: string; draftRevisionToken: string } | null,
      ) => Promise<DraftCommandOutcome>,
    ): Promise<DraftCommandOutcome> => {
      // The selection comes from state, not from the editor runtime: the
      // command is server-backed, so a list row works with no manuscript mounted.
      const current = stateRef.current;
      const inline = current.surface.kind === "inline" ? current.surface : null;
      if (!inline) return { kind: "blocked" };
      const cached = queryClient.getQueryData<DraftPreviewResponse>(
        projectQueryKeys.workDraftPreview(projectId, workId, inline.documentId, inline.draftId),
      );
      const outcome = await command(
        { documentId: inline.documentId, draftId: inline.draftId },
        cached?.status === "active"
          ? {
              liveRevisionToken: cached.liveRevisionToken,
              draftRevisionToken: cached.draftRevisionToken,
            }
          : null,
      );
      if (!activeRef.current) return outcome;
      if (
        outcome.kind === "change-settled" ||
        (outcome.kind === "change-refused" && outcome.code === "gone")
      ) {
        // The cache already lost the change (`settleConfirmedChange`): if that
        // was the last one, the review stays open to say so rather than
        // closing under the writer when the draft leaves the server's list.
        const after = queryClient.getQueryData<DraftPreviewResponse>(
          projectQueryKeys.workDraftPreview(projectId, workId, inline.documentId, inline.draftId),
        );
        if (
          after?.status === "active" &&
          reviewChanges(after.operations, after.hunks).length === 0
        ) {
          dispatch({
            type: "reviewCleared",
            documentId: inline.documentId,
            draftId: inline.draftId,
          });
          // The server keeps the emptied draft in its list; the writer is not offered it again.
          const listed = queryClient
            .getQueryData<ThreadDraftListItem[]>(projectQueryKeys.workDrafts(projectId, workId))
            ?.find((item) => item.draftId === inline.draftId);
          markDraftCleared(
            { projectId, workId, documentId: inline.documentId, draftId: inline.draftId },
            {
              lastActorTurnId: listed?.lastActorTurnId ?? null,
              documentName: listed?.documentName ?? null,
            },
          );
        }
      }
      if (outcome.kind === "change-settled") {
        dispatch({
          type: "toast",
          code: outcome.mode === "apply" ? "applied" : "discarded",
          tone: "info",
        });
      } else if (outcome.kind === "change-refused" && outcome.code === "gone") {
        dispatch({ type: "toast", code: "change-gone", tone: "error" });
      }
      return outcome;
    },
    [projectId, queryClient, workId],
  );

  const applyChange = useCallback(
    (change: ChangeRef): Promise<DraftCommandOutcome> =>
      runChangeCommand((selection, tokens) =>
        // Without a preview there is nothing the writer saw to apply: treat it as an out-of-date change.
        tokens
          ? reviewSession.applyChange(selection, change, tokens)
          : Promise.resolve({ kind: "change-refused", mode: "apply", code: "stale" }),
      ),
    [reviewSession, runChangeCommand],
  );

  const discardChange = useCallback(
    (change: ChangeRef): Promise<DraftCommandOutcome> =>
      runChangeCommand((selection) => reviewSession.discardChange(selection, change)),
    [reviewSession, runChangeCommand],
  );

  const apply = useCallback(
    (documentId: string, draftId: string): Promise<DraftCommandOutcome> =>
      reviewSession.applyReviewedDraft({ documentId, draftId }),
    [reviewSession],
  );

  const discard = useCallback(
    (documentId: string, draftId: string): Promise<DraftCommandOutcome> =>
      reviewSession.discardDraft({ documentId, draftId }),
    [reviewSession],
  );

  const disposeDrafts = useCallback(
    (
      mode: "apply" | "discard",
      drafts: readonly DraftReviewSelection[],
    ): Promise<DraftCommandOutcome[]> => reviewSession.disposeDrafts(mode, drafts),
    [reviewSession],
  );

  return useMemo(
    () => ({
      projectId,
      workId,
      threadId,
      inlineReview,
      reviewRoomName,
      reviewRoomError,
      isApplying,
      isDiscarding,
      isPending,
      canApplyReviewedDraft,
      isDisposing,
      dispositionLocked,
      inlineReviewMessage,
      marksVisible: state.marksVisible,
      setMarksVisible,
      focusedClassId: inlineReview?.focusedClassId ?? null,
      reportFocusedClass,
      focusReviewChange,
      applyChange,
      discardChange,
      toast: state.toast,
      dismissToast,
      dockDispositionError,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      setInlineReviewShown,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      apply,
      discard,
      disposeDrafts,
    }),
    [
      projectId,
      workId,
      threadId,
      inlineReview,
      reviewRoomName,
      reviewRoomError,
      isApplying,
      isDiscarding,
      isPending,
      canApplyReviewedDraft,
      isDisposing,
      dispositionLocked,
      inlineReviewMessage,
      state.marksVisible,
      setMarksVisible,
      inlineReview?.focusedClassId,
      reportFocusedClass,
      focusReviewChange,
      applyChange,
      discardChange,
      state.toast,
      dismissToast,
      dockDispositionError,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      setInlineReviewShown,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      apply,
      discard,
      disposeDrafts,
    ],
  );
}
