/** useDraftReviewController — shared state machine for reviewing AI document drafts. */

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
import {
  clearDraftCommandFailure,
  draftCommandPendingIn,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  DraftApplyOutcomeUnknownError,
  useApplyDraft,
  useDiscardDraft,
} from "@/client/query/useDraftReviewMutations";
import { getContextTabs } from "@/client/stores";
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
} from "./draft-review-session";

export type { DraftReviewSelection, InlineDraftReview, InlineReviewMessageCode };

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
  isInlineDiscardPending: boolean;
  canApplyReviewedDraft: boolean;
  /**
   * The global disposition lock: any Apply/Discard in flight in the session.
   * Every mutating control disables on it so dispositions can't overlap.
   */
  isDisposing: boolean;
  pendingInlineDiscardIds: (draftId: string | null | undefined) => ReadonlySet<string>;
  inlineReviewMessage: InlineReviewMessage | null;
  inlineDiscardError: InlineReviewMessageCode | null;
  dockDispositionError: DraftBatchErrorCode | null;
  enterInlineReview: (documentId: string, draftId: string) => void;
  exitInlineReview: () => void;
  exitReview: () => void;
  inlineReviewModelAvailable: (identity: string, documentId: string, draftId: string) => void;
  /** Claim/release the single review-runtime slot. */
  registerInlineReviewRuntime: (runtime: InlineReviewRuntime) => void;
  releaseInlineReviewRuntime: (editor: Editor) => void;
  focusReviewOperation: (operationId: string) => void;
  discardOperation: (operationId: string) => Promise<DraftCommandOutcome>;
  apply: (documentId: string, draftId: string) => Promise<DraftCommandOutcome>;
  discard: (documentId: string, draftId: string) => Promise<DraftCommandOutcome>;
  disposeDrafts: (
    mode: "apply" | "discard",
    drafts: readonly DraftReviewSelection[],
  ) => Promise<DraftCommandOutcome[]>;
};

export function useDraftReviewController(
  projectId: string,
  workId: string,
  threadId: string | null = null,
  stateOwner?: DraftReviewStateOwner,
): DraftReviewController {
  const queryClient = useQueryClient();
  const contextRemoval = useContextRemovalCoordinator();
  const openContextRoute = useOpenContextRoute();
  const isCurrentContextRoute = useIsCurrentContextRoute();
  const applyMutation = useApplyDraft();
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
  const inlineDiscardError = state.inlineDiscardError;
  const dockDispositionError = state.dockDispositionError;

  const activeDisposition = disposition.busy ? disposition.target : null;
  const isApplying = activeDisposition?.kind === "apply-draft";
  const isDiscarding = activeDisposition?.kind === "discard-draft";
  const isInlineDiscardPending = activeDisposition?.kind === "discard-operation";
  const isPending = isApplying || isDiscarding;
  // A command in flight on any draft of this Work, from any surface, disables this one.
  const commandRecords = useDraftCommandRecords();
  const isDisposing =
    disposition.busy || draftCommandPendingIn(commandRecords, { projectId, workId });
  const canApplyReviewedDraft =
    state.surface.kind === "inline" && state.surface.previewIdentity !== undefined;
  const pendingInlineDiscardIds = useCallback(
    (draftId: string | null | undefined): ReadonlySet<string> =>
      activeDisposition?.kind === "discard-operation" && activeDisposition.draftId === draftId
        ? new Set([activeDisposition.operationId])
        : EMPTY_OPERATION_IDS,
    [activeDisposition],
  );

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
    operationDiscardStarted: () => {
      dispatch({ type: "discardStarted" });
    },
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

  const focusReviewOperation = useCallback((operationId: string) => {
    const editor = inlineRuntimeRef.current?.editor;
    if (!editor || editor.isDestroyed) return;
    editor.commands.setInlineReviewActiveOperation(operationId);
    editor.commands.scrollInlineReviewOperationIntoView(operationId);
  }, []);

  const discardOperation = useCallback(
    async (operationId: string): Promise<DraftCommandOutcome> => {
      // The review selection comes from state, not from the editor runtime:
      // the disposition is server-backed, so a Changes card must work on
      // screens where the manuscript is not mounted.
      const current = stateRef.current;
      const inline = current.surface.kind === "inline" ? current.surface : null;
      if (!inline) return { kind: "failed", code: "discard-failed" };
      const outcome = await reviewSession.discardOperation(inline, operationId);
      if (outcome.kind === "failed") {
        dispatch({
          type: "discardFailed",
          code: outcome.code,
        });
      }
      return outcome;
    },
    [reviewSession],
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
      isInlineDiscardPending,
      canApplyReviewedDraft,
      isDisposing,
      pendingInlineDiscardIds,
      inlineReviewMessage,
      inlineDiscardError,
      dockDispositionError,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      focusReviewOperation,
      discardOperation,
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
      isInlineDiscardPending,
      canApplyReviewedDraft,
      isDisposing,
      pendingInlineDiscardIds,
      inlineReviewMessage,
      inlineDiscardError,
      dockDispositionError,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      inlineReviewModelAvailable,
      registerInlineReviewRuntime,
      releaseInlineReviewRuntime,
      focusReviewOperation,
      discardOperation,
      apply,
      discard,
      disposeDrafts,
    ],
  );
}

const EMPTY_OPERATION_IDS = new Set<string>();
