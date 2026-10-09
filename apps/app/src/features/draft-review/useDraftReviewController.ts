/** useDraftReviewController — shared state machine for reviewing AI document drafts. */

import type { DraftPreviewResponse, ThreadDraftListItem } from "@meridian/contracts/drafts";
import { isWorkArchived, type Work } from "@meridian/contracts/works";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import {
  type Dispatch,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  answerDraftCommandClosed,
  clearDraftReviewLaunchFailure,
  draftCommandPendingIn,
  useDraftCommandRecords,
} from "@/client/query/draft-command-record";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { draftPreviewQueryOptions } from "@/client/query/useDraftPreview";
import {
  DraftCommandOutcomeUnknownError,
  settleConfirmedChange,
  useApplyDraft,
  useApplyDraftChanges,
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
  type DraftCommandOutcome,
  type DraftReviewCommandPorts,
  type DraftReviewSelection,
  DraftReviewSession,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  type InlineDraftReview,
  inlineReviewFromState,
  type ReviewToast,
} from "./draft-review-session";
import { type ReviewFocus, reviewChangesOfPreview } from "./review-changes";
import { draftClaim, useReviewCommandCompletion } from "./useReviewCommandCompletion";
import { useReviewGeneration } from "./useReviewGeneration";
import {
  listedDocumentName,
  type SelectionCommand,
  useSelectionCommands,
} from "./useSelectionCommands";

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
  draftId: string;
};

/** A command whose request got no answer settles as "unknown"; a rejection still throws. */
async function unlessOutcomeUnknown<T>(command: Promise<T>): Promise<T | "unknown"> {
  try {
    return await command;
  } catch (error) {
    if (error instanceof DraftCommandOutcomeUnknownError) return "unknown";
    throw error;
  }
}

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
    options?: { scroll?: boolean },
  ) => void;
  /**
   * Apply or Discard a selection of changes of any draft of this Work. The
   * changes leave every surface at once. Completion (`Applying`, "No changes
   * left") runs only when the draft is this controller's open review; a
   * caller never picks the controller itself (`useChangeCommandRunner`).
   */
  applyChanges: SelectionCommand;
  discardChanges: SelectionCommand;
  toast: ReviewToast | null;
  dismissToast: (id: number) => void;
  enterInlineReview: (documentId: string, draftId: string) => void;
  /**
   * The editor's room reports it is of a generation the server has closed
   * (`branch-generation-stale`). The review asks for a fresh read and keeps its
   * place; it neither exits nor guesses the new room.
   */
  reviewRoomStale: (documentId: string, draftId: string, roomName: string) => void;
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
  // One session per Work: the controller outlives navigation between Works, and
  // a command still in flight in the Work left behind must not keep the new
  // Work's controls disabled. The session owns its ports from its creation: each
  // render of this Work refreshes them, and the next Work's render makes a
  // session of its own, so a command sent through this one afterwards (a batch
  // that began here) still acts in this Work whether or not it ever ran before.
  const { session: reviewSession, ports: commandPortsRef } = useMemo(() => {
    const ports: { current: DraftReviewCommandPorts | null } = { current: null };
    const session = new DraftReviewSession(() => {
      if (!ports.current) throw new Error("Draft review command ports are not ready.");
      return ports.current;
    });
    return { session, ports };
  }, [projectId, workId]);
  const dispositionLock = reviewSession.disposition;
  const disposition = useSyncExternalStore(
    dispositionLock.subscribe,
    dispositionLock.getSnapshot,
    dispositionLock.getSnapshot,
  );
  const stateRef = useRef(state);
  const activeRef = useRef(true);
  const inlineRuntimeRef = useRef<InlineReviewRuntime | null>(null);
  /** The review open when Apply all or Discard all began: its generation, and its name as listed then. */
  const batchReviewedRef = useRef<
    (DraftReviewSelection & { draftGeneration: number; documentName: string | null }) | null
  >(null);
  stateRef.current = state;

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const inlineReview = inlineReviewFromState(state);

  const activeDisposition = disposition.busy ? disposition.target : null;
  const isApplying = activeDisposition?.kind === "apply-draft";
  // A command in flight on any draft of this Work, from any surface, disables this one.
  const commandRecords = useDraftCommandRecords();
  const isDisposing =
    disposition.busy || draftCommandPendingIn(commandRecords, { projectId, workId });
  const dispositionLocked = isDisposing || draftsFrozen;
  const canApplyReviewedDraft =
    state.surface.kind === "inline" && state.surface.previewIdentity !== undefined;

  // The review's room is the preview's: found through the one fenced preview
  // query, read fresh, so the read joins any in flight, commits to the shared
  // cache only through the fence (a change handled meanwhile cannot come back),
  // and what it reports is addressed to the draft, so a review that has moved on
  // takes nothing from it. A review asks for a room by having none: entering,
  // re-entering a generation, and a room reported stale all clear it.
  const reviewedDocumentId = inlineReview?.documentId;
  const reviewedDraftId = inlineReview?.draftId;
  const reviewedGeneration = inlineReview?.draftGeneration;
  const roomWanted = inlineReview !== null && !inlineReview.roomName && !inlineReview.roomError;
  useEffect(() => {
    if (!roomWanted || !reviewedDocumentId || !reviewedDraftId) return;
    const draft = { projectId, workId, documentId: reviewedDocumentId, draftId: reviewedDraftId };
    const readFresh = () =>
      queryClient.fetchQuery({ ...draftPreviewQueryOptions(draft), staleTime: 0 });
    let owned = true;
    void (async () => {
      let preview = await readFresh();
      // A read already in flight can predate the generation the review shows; it
      // has settled, so one more read starts after it.
      const shown = stateRef.current.surface;
      if (
        preview.status === "active" &&
        shown.kind === "inline" &&
        shown.draftId === reviewedDraftId &&
        shown.draftGeneration !== undefined &&
        preview.draftGeneration < shown.draftGeneration
      )
        preview = await readFresh();
      if (!owned || preview.status !== "active") return;
      dispatch({
        type: "generationObserved",
        documentId: reviewedDocumentId,
        draftId: reviewedDraftId,
        draftGeneration: preview.draftGeneration,
        proposal: preview.inlineModelPresent && reviewChangesOfPreview(preview).length > 0,
        claim: draftClaim(queryClient, draft),
        roomName: preview.reviewRoomName,
      });
    })().catch(() => {
      if (owned)
        dispatch({ type: "roomFailed", documentId: reviewedDocumentId, draftId: reviewedDraftId });
    });
    return () => {
      owned = false;
    };
  }, [
    roomWanted,
    reviewedDocumentId,
    reviewedDraftId,
    reviewedGeneration,
    projectId,
    workId,
    queryClient,
    dispatch,
  ]);

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

  /**
   * Apply all or Discard all closed the draft the writer is reviewing. The
   * review holds on "No changes left" (as it does after the last change) so the
   * batch's pending and settled outcome stays in front of them, rather than
   * falling to live as if every draft had applied.
   */
  const holdBatchClosedReview = (documentId: string, draftId: string): boolean => {
    const reviewed = batchReviewedRef.current;
    if (reviewed?.documentId !== documentId || reviewed.draftId !== draftId) return false;
    const inline = stateRef.current.surface;
    if (inline.kind !== "inline" || inline.documentId !== documentId || inline.draftId !== draftId)
      return false;
    if (!activeRef.current) return false;
    dispatch({
      type: "reviewClosed",
      documentId,
      draftId,
      draftGeneration: reviewed.draftGeneration,
      documentName: reviewed.documentName,
    });
    return true;
  };

  commandPortsRef.current = {
    scope: { projectId, workId },
    apply: async ({ documentId, draftId }) => {
      const tab = getContextTabs(projectId).tabs.find(
        (candidate) => candidate.documentId === documentId,
      );
      if (
        (await unlessOutcomeUnknown(
          applyMutation.mutateAsync({ projectId, workId, threadId, documentId, draftId }),
        )) === "unknown"
      )
        return "unknown";
      // Confirmed is terminal for the command: the batch advances now. Tab
      // promotion and the route repair are navigation's business and run on.
      void settleConfirmedApply(tab);
      return "applied";
    },
    discard: async ({ documentId, draftId }) => {
      await discardMutation.mutateAsync({ projectId, workId, threadId, documentId, draftId });
    },
    discardChanges: ({ documentId, draftId }, request) =>
      unlessOutcomeUnknown(
        discardMutation.mutateAsync({
          projectId,
          workId,
          threadId,
          documentId,
          draftId,
          request,
          // Only an answered Discard can close the draft; a refusal says nothing about it.
          onAnswered: (response) => {
            if (response.status === "discarded" && response.draftClosed)
              answerDraftCommandClosed(
                { projectId, workId, documentId, draftId },
                // Read now: the draft leaves the list once the answer's reads land.
                { documentName: listedDocumentName(queryClient, projectId, workId, draftId) },
              );
          },
        }),
      ),
    applyChanges: ({ documentId, draftId }, request) =>
      unlessOutcomeUnknown(
        applyChangesMutation.mutateAsync({
          projectId,
          workId,
          threadId,
          documentId,
          draftId,
          request,
          onAnswered: (response) => {
            if (response.status === "applied" && response.draftClosed)
              answerDraftCommandClosed(
                { projectId, workId, documentId, draftId },
                // Read now: the draft leaves the list once the answer's reads land.
                { documentName: listedDocumentName(queryClient, projectId, workId, draftId) },
              );
          },
        }),
      ),
    changeConfirmed: ({ documentId, draftId }, selection, mode) =>
      settleConfirmedChange(
        queryClient,
        { projectId, workId, threadId, documentId, draftId },
        selection,
        mode,
      ),
    batchStarted: (mode) => {
      // The review the writer is in is part of the batch: its completion is pending
      // until its own command answers, and the header says so. Read now: the draft
      // leaves the Work's list when it is applied.
      const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
      const listedDraft = inline
        ? queryClient
            .getQueryData<ThreadDraftListItem[]>(projectQueryKeys.workDrafts(projectId, workId))
            ?.find((item) => item.draftId === inline.draftId)
        : undefined;
      // A new document's review is promoted to the live document, not held; so
      // is one that has not yet learned which generation it shows.
      if (inline && inline.draftGeneration !== undefined && listedDraft?.isNewDocument !== true) {
        const documentName = listedDraft?.documentName ?? null;
        batchReviewedRef.current = {
          documentId: inline.documentId,
          draftId: inline.draftId,
          draftGeneration: inline.draftGeneration,
          documentName,
        };
        dispatch({
          type: "reviewCompleting",
          documentId: inline.documentId,
          draftId: inline.draftId,
          draftGeneration: inline.draftGeneration,
          mode,
          documentName,
        });
      } else {
        batchReviewedRef.current = null;
      }
    },
    batchSettled: () => {
      const reviewed = batchReviewedRef.current;
      batchReviewedRef.current = null;
      // Its command did not close it (refused, lost): the review carries on, with
      // the refusal on it. A no-op when it closed.
      if (reviewed)
        dispatch({
          type: "reviewReopened",
          documentId: reviewed.documentId,
          draftId: reviewed.draftId,
          draftGeneration: reviewed.draftGeneration,
        });
    },
    // The tab closes with the click; a refusal leaves it closed and the error
    // on the draft (see draft-command-record).
    draftDiscardStarted: (selection) => {
      contextRemoval.discardDraft(projectId, workId, selection.documentId, selection.draftId);
    },
    draftApplied: ({ documentId, draftId }) => {
      if (!holdBatchClosedReview(documentId, draftId))
        dispatch({ type: "applySucceeded", documentId, draftId });
    },
    draftDiscarded: ({ documentId, draftId }) => {
      if (!holdBatchClosedReview(documentId, draftId))
        dispatch({ type: "discardSucceeded", draftId });
      contextRemoval.discardDraft(projectId, workId, documentId, draftId);
    },
  };

  const enterInlineReview = useCallback(
    (documentId: string, draftId: string) => {
      const draft = { projectId, workId, documentId, draftId };
      clearDraftReviewLaunchFailure(draft);
      // The review opens on the newest proposal the caches know of, and a command
      // already in flight on this draft (sent from the strip or the Work page)
      // is its to show: it adopts the claim if it acted on that generation.
      dispatch({
        type: "enterInline",
        documentId,
        draftId,
        draftGeneration: newestKnownProposal(queryClient, draft),
        claim: draftClaim(queryClient, draft),
      });
    },
    [projectId, queryClient, workId],
  );

  const reviewRoomStale = useCallback((documentId: string, draftId: string, roomName: string) => {
    dispatch({ type: "roomStale", documentId, draftId, roomName });
  }, []);

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
    dispatch({ type: "exitInline" });
  }, [projectId, queryClient, workId]);

  const exitReview = useCallback(() => {
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

  const reportFocusedChange = useCallback((review: DraftReviewSelection, change: ReviewFocus) => {
    dispatch({
      type: "changeFocused",
      documentId: review.documentId,
      draftId: review.draftId,
      focus: { classId: change.classId, operationIds: change.operationIds },
    });
  }, []);

  const focusReviewChange = useCallback(
    (review: DraftReviewSelection, change: ReviewChangeTarget, options?: { scroll?: boolean }) => {
      // The identity is checked before anything is touched: the open review, and
      // the editor showing it, are the ones this focus was meant for.
      const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
      if (inline?.documentId !== review.documentId || inline.draftId !== review.draftId) return;
      reportFocusedChange(review, change);
      const runtime = inlineRuntimeRef.current;
      if (
        !runtime ||
        runtime.documentId !== review.documentId ||
        runtime.draftId !== review.draftId ||
        runtime.editor.isDestroyed
      )
        return;
      runtime.editor.commands.setInlineReviewActiveOperation(change.anchorOperationId);
      if (options?.scroll)
        runtime.editor.commands.scrollInlineReviewOperationIntoView(change.anchorOperationId);
    },
    [reportFocusedChange],
  );

  const setMarksVisible = useCallback((visible: boolean) => {
    dispatch({ type: "marksVisible", visible });
  }, []);

  const dismissToast = useCallback((id: number) => {
    dispatch({ type: "toastDismissed", id });
  }, []);

  useReviewCommandCompletion({ projectId, workId, activeRef, dispatch });
  useReviewGeneration({ projectId, workId, inlineReview, activeRef, dispatch });

  const { applyChanges, discardChanges } = useSelectionCommands({
    projectId,
    workId,
    session: reviewSession,
    stateRef,
    activeRef,
    dispatch,
  });

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
      reviewRoomName: inlineReview?.roomName ?? null,
      reviewRoomError: inlineReview?.roomError ?? false,
      isApplying,
      canApplyReviewedDraft,
      isDisposing,
      dispositionLocked,
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
      reviewRoomStale,
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
      isApplying,
      canApplyReviewedDraft,
      isDisposing,
      dispositionLocked,
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
      reviewRoomStale,
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

/**
 * The newest proposal the caches know of for a draft being entered: the cached
 * preview when it lists changes (a reset's empty preview is not one), and the
 * draft's list row. Undefined when neither is there; the room read then says.
 */
function newestKnownProposal(
  queryClient: QueryClient,
  draft: { projectId: string; workId: string; documentId: string; draftId: string },
): number | undefined {
  const known: number[] = [];
  const cached = queryClient.getQueryData<DraftPreviewResponse>(
    projectQueryKeys.workDraftPreview(
      draft.projectId,
      draft.workId,
      draft.documentId,
      draft.draftId,
    ),
  );
  if (
    cached?.status === "active" &&
    cached.inlineModelPresent &&
    reviewChangesOfPreview(cached).length > 0
  )
    known.push(cached.draftGeneration);
  const row = queryClient
    .getQueryData<ThreadDraftListItem[]>(projectQueryKeys.workDrafts(draft.projectId, draft.workId))
    ?.find((item) => item.draftId === draft.draftId);
  if (row) known.push(row.draftGeneration);
  return known.length > 0 ? Math.max(...known) : undefined;
}
