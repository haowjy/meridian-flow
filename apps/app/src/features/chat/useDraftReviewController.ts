/**
 * useDraftReviewController — shared state machine for reviewing AI document drafts.
 *
 * Cards and the preview overlay both let the writer apply or discard a draft;
 * this controller keeps those paths on one accept/reject flow so overlap
 * confirmation and overlay cleanup cannot drift between surfaces.
 */

import { draftRoomName } from "@meridian/contracts/protocol";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { getDraftPreview } from "@/client/api/drafts-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  useAcceptDraft,
  useRejectDraft,
  useUndoDraftAccept,
} from "@/client/query/useDraftReviewMutations";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";
import type { InlineReviewModel } from "@/core/editor/extensions/inline-review";
import {
  acceptIsBlocked,
  type DraftReviewOverlap,
  type DraftReviewSelection,
  discardCanStart,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  type InlineDraftReview,
  type InlineReviewMessage,
  inlineDiscardIsPending,
  inlineReviewFromState,
  pendingDiscardIdsForDraft,
  pendingDiscardIdsMissingFromModel,
  selectedDraftFromState,
} from "./draft-review-controller-transitions";
import {
  type InlineReviewJournalCache,
  type InlineReviewRejectContext,
  type InlineReviewRejectOutcome,
  rejectInlineReviewOperation,
} from "./inline-review-discard-operation";

export type { DraftReviewOverlap, DraftReviewSelection, InlineDraftReview };

export type DraftReviewOpenOptions = {
  requireOverlapConfirm?: boolean;
  liveRevisionToken?: number;
};

export type DraftReviewController = {
  projectId: string;
  workId: string;
  selectedDraft: DraftReviewSelection | null;
  inlineReview: InlineDraftReview | null;
  overlap: DraftReviewOverlap | null;
  staleDraft: DraftReviewSelection | null;
  staleDraftMessage: string | null;
  isAccepting: boolean;
  isRejecting: boolean;
  isPending: boolean;
  isInlineDiscardPending: boolean;
  pendingInlineDiscardIds: (draftId: string | null | undefined) => ReadonlySet<string>;
  confirmingAcceptOperationId: string | null;
  confirmingDiscardOperationId: string | null;
  inlineReviewMessage: InlineReviewMessage | null;
  inlineDiscardError: string | null;
  isOperationAccepting: boolean;
  isOperationUndoing: boolean;
  openReview: (documentId: string, draftId: string, options?: DraftReviewOpenOptions) => void;
  closeReview: () => void;
  enterInlineReview: (documentId: string, draftId: string) => void;
  exitInlineReview: () => void;
  exitReview: () => void;
  fallbackInlineReviewToPanel: (documentId: string, draftId: string) => void;
  inlineReviewModelUnavailable: (
    documentId: string,
    draftId: string,
    identity: string,
    operationIds: readonly string[],
  ) => void;
  inlineReviewModelAvailable: (
    identity: string,
    draftId?: string,
    operationIds?: readonly string[],
  ) => void;
  setInlineReviewRuntime: (runtime: InlineReviewRejectContext | null) => void;
  confirmAcceptOperation: (operationId: string) => void;
  cancelAcceptOperation: () => void;
  acceptOperation: (operationId: string, model: InlineReviewModel) => void;
  undoAcceptOperation: () => void;
  confirmDiscardOperation: (operationId: string) => void;
  cancelDiscardOperation: () => void;
  discardOperation: (operationId: string) => Promise<void>;
  accept: (
    documentId: string,
    draftId: string,
    options?: { confirmedLiveRevisionToken?: number },
  ) => void;
  reject: (documentId: string, draftId: string) => void;
};

export function useDraftReviewController(projectId: string, workId: string): DraftReviewController {
  const queryClient = useQueryClient();
  const acceptMutation = useAcceptDraft();
  const operationAcceptMutation = useAcceptDraft();
  const rejectMutation = useRejectDraft();
  const undoAcceptMutation = useUndoDraftAccept();
  const [state, dispatch] = useReducer(draftReviewReducer, EMPTY_DRAFT_REVIEW_STATE);
  const stateRef = useRef(state);
  const inlineRuntimeRef = useRef<InlineReviewRejectContext | null>(null);
  const journalCacheRef = useRef<InlineReviewJournalCache>(new Map());
  const pendingDiscardTimersRef = useRef<Map<string, number>>(new Map());
  stateRef.current = state;

  const selectedDraft = selectedDraftFromState(state);
  const inlineReview = inlineReviewFromState(state);
  const overlap = state.overlap;
  const staleDraft = state.staleDraft;
  const isInlineDiscardPending = inlineDiscardIsPending(state);
  const confirmingAcceptOperationId = state.confirmingAcceptOperationId;
  const confirmingDiscardOperationId = state.confirmingDiscardOperationId;
  const inlineReviewMessage = state.inlineReviewMessage;
  const inlineDiscardError = state.inlineDiscardError;

  const staleDraftMessage = staleDraft
    ? "The draft changed — review the latest changes before applying."
    : null;
  const isAccepting = acceptMutation.isPending;
  const isRejecting = rejectMutation.isPending;
  const isOperationAccepting = operationAcceptMutation.isPending;
  const isOperationUndoing = undoAcceptMutation.isPending;
  const isPending = isAccepting || isRejecting;

  const openReview = useCallback(
    (documentId: string, draftId: string, options?: DraftReviewOpenOptions) => {
      dispatch({
        type: "openPanel",
        documentId,
        draftId,
        overlap: options?.requireOverlapConfirm
          ? { draftId, liveRevisionToken: options.liveRevisionToken }
          : null,
      });
    },
    [],
  );

  const closeReview = useCallback(() => {
    dispatch({ type: "exitPanel" });
  }, []);

  const enterInlineReview = useCallback((documentId: string, draftId: string) => {
    dispatch({ type: "enterInline", documentId, draftId });
  }, []);

  const exitInlineReview = useCallback(() => {
    dispatch({ type: "exitInline" });
  }, []);

  const exitReview = useCallback(() => {
    dispatch({ type: "exitReview" });
  }, []);

  const fallbackInlineReviewToPanel = useCallback((documentId: string, draftId: string) => {
    dispatch({ type: "hardFallbackToPanel", documentId, draftId });
  }, []);

  const inlineReviewModelUnavailable = useCallback(
    (documentId: string, draftId: string, identity: string, operationIds: readonly string[]) => {
      const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
      if (inline?.documentId === documentId && inline.draftId === draftId) {
        for (const operationId of pendingDiscardIdsMissingFromModel(
          stateRef.current,
          draftId,
          operationIds,
        )) {
          clearPendingDiscardTimer(pendingDiscardTimersRef.current, draftId, operationId);
          dispatch({ type: "discardSettled", draftId, operationId });
        }
      }
      dispatch({ type: "inlineModelUnavailable", documentId, draftId, identity });
    },
    [],
  );

  const inlineReviewModelAvailable = useCallback(
    (identity: string, draftId?: string, operationIds?: readonly string[]) => {
      dispatch({ type: "inlineModelAvailable", identity });
      if (!draftId || !operationIds) return;
      for (const operationId of pendingDiscardIdsMissingFromModel(
        stateRef.current,
        draftId,
        operationIds,
      )) {
        clearPendingDiscardTimer(pendingDiscardTimersRef.current, draftId, operationId);
        dispatch({ type: "discardSettled", draftId, operationId });
      }
    },
    [],
  );

  const setInlineReviewRuntime = useCallback((runtime: InlineReviewRejectContext | null) => {
    inlineRuntimeRef.current = runtime;
  }, []);

  const pendingInlineDiscardIds = useCallback(
    (draftId: string | null | undefined) => pendingDiscardIdsForDraft(stateRef.current, draftId),
    [],
  );

  useEffect(() => {
    return () => {
      for (const timer of pendingDiscardTimersRef.current.values()) window.clearTimeout(timer);
      pendingDiscardTimersRef.current.clear();
    };
  }, []);

  const confirmAcceptOperation = useCallback((operationId: string) => {
    dispatch({ type: "confirmAcceptOperation", operationId });
  }, []);

  const cancelAcceptOperation = useCallback(() => {
    dispatch({ type: "cancelAcceptOperation" });
  }, []);

  const acceptOperation = useCallback(
    (operationId: string, model: InlineReviewModel) => {
      const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
      if (!inline || operationAcceptMutation.isPending || undoAcceptMutation.isPending) return;
      const operation = model.operations.find((candidate) => candidate.operationId === operationId);
      if (!operation) return;
      const confirmClosure = stateRef.current.confirmingAcceptOperationId === operationId;
      dispatch({ type: "operationAcceptStarted" });
      operationAcceptMutation.mutate(
        {
          projectId,
          workId,
          documentId: inline.documentId,
          draftId: inline.draftId,
          draftRevisionToken: model.draftRevisionToken,
          operationIds: [operationId],
          confirmedClosureOperationIds: confirmClosure
            ? (operation.acceptClosureOperationIds ?? [operation.operationId])
            : undefined,
          confirmedLiveRevisionToken: confirmClosure ? model.liveRevisionToken : undefined,
        },
        {
          onSuccess(response) {
            if (response.status === "partial_applied") {
              dispatch({
                type: "operationAcceptSucceeded",
                message: { text: "Applied proposal", writeId: response.writeId },
              });
            } else if (response.status === "stale_draft") {
              dispatch({
                type: "operationAcceptSucceeded",
                message: { text: "Draft changed — refreshed proposals." },
              });
            } else if (response.status === "causal_dependency") {
              dispatch({ type: "operationAcceptSucceeded", message: { text: response.message } });
            } else if (response.status === "closure_confirmation_required") {
              dispatch({ type: "confirmAcceptOperation", operationId });
            }
          },
          onError() {
            dispatch({
              type: "operationAcceptFailed",
              message: {
                text: "Couldn't accept. Check your connection and try again.",
                tone: "error",
              },
            });
          },
        },
      );
    },
    [operationAcceptMutation, undoAcceptMutation.isPending, projectId, workId],
  );

  const undoAcceptOperation = useCallback(() => {
    const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
    const writeId = stateRef.current.inlineReviewMessage?.writeId;
    if (!inline || !writeId || undoAcceptMutation.isPending) return;
    undoAcceptMutation.mutate(
      { projectId, workId, documentId: inline.documentId, draftId: inline.draftId, writeId },
      {
        onSuccess() {
          dispatch({
            type: "operationUndoAcceptSucceeded",
            message: { text: "Proposal restored." },
          });
        },
        onError() {
          dispatch({
            type: "operationUndoAcceptFailed",
            message: { text: "Undo failed. Nothing changed.", tone: "error" },
          });
        },
      },
    );
  }, [projectId, undoAcceptMutation, workId]);

  const confirmDiscardOperation = useCallback((operationId: string) => {
    dispatch({ type: "confirmDiscardOperation", operationId });
  }, []);

  const cancelDiscardOperation = useCallback(() => {
    dispatch({ type: "cancelDiscardOperation" });
  }, []);

  const discardOperation = useCallback(
    async (operationId: string) => {
      const runtime = inlineRuntimeRef.current;
      if (!runtime?.draftId || inlineDiscardIsPending(stateRef.current, runtime.draftId)) return;
      if (!discardCanStart(stateRef.current, runtime.draftId)) return;
      dispatch({ type: "discardStarted", draftId: runtime.draftId, operationId });
      try {
        const outcome = await rejectInlineReviewOperation({
          ...runtime,
          operationId,
          queryClient,
          journalCache: journalCacheRef.current,
        });
        if (outcome.status !== "applied") {
          dispatch({
            type: "discardFailed",
            draftId: runtime.draftId,
            operationId,
            message: messageForRejectOutcome(outcome),
          });
          return;
        }
        const timer = window.setTimeout(() => {
          pendingDiscardTimersRef.current.delete(discardTimerKey(runtime.draftId, operationId));
          if (!pendingDiscardIdsForDraft(stateRef.current, runtime.draftId).has(operationId))
            return;
          dispatch({
            type: "discardFailed",
            draftId: runtime.draftId,
            operationId,
            message: "Discard didn't stick — the draft may have been finalized.",
          });
        }, 4500);
        pendingDiscardTimersRef.current.set(discardTimerKey(runtime.draftId, operationId), timer);
      } catch {
        dispatch({
          type: "discardFailed",
          draftId: runtime.draftId,
          operationId,
          message: "Couldn't discard. Check your connection and try again.",
        });
      }
    },
    [queryClient],
  );

  const accept = useCallback(
    async (
      documentId: string,
      draftId: string,
      options?: { confirmedLiveRevisionToken?: number },
    ) => {
      if (
        acceptIsBlocked({
          isPending,
          isInlineDiscardPending: inlineDiscardIsPending(stateRef.current),
        })
      ) {
        return;
      }
      const needsOverlapConfirm = overlap?.draftId === draftId;
      await waitForDraftDocumentSync(draftId);
      const draftRevisionToken = await latestPreviewDraftRevisionToken(
        queryClient,
        projectId,
        workId,
        documentId,
        draftId,
      );
      acceptMutation.mutate(
        {
          projectId,
          workId,
          documentId,
          draftId,
          draftRevisionToken,
          confirmOverlap: needsOverlapConfirm,
          confirmedLiveRevisionToken: needsOverlapConfirm
            ? (options?.confirmedLiveRevisionToken ?? overlap.liveRevisionToken)
            : undefined,
        },
        {
          onSuccess(response) {
            if (response.status === "stale_draft" || response.status === "causal_dependency") {
              void queryClient.invalidateQueries({
                queryKey: projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId),
              });
            }
            dispatch({ type: "applySucceeded", documentId, draftId, response });
          },
        },
      );
    },
    [acceptMutation, isPending, overlap, queryClient, projectId, workId],
  );

  const reject = useCallback(
    (documentId: string, draftId: string) => {
      if (isPending) return;
      rejectMutation.mutate(
        { projectId, workId, documentId, draftId },
        {
          onSuccess() {
            dispatch({ type: "rejectSucceeded", draftId });
          },
        },
      );
    },
    [isPending, rejectMutation, projectId, workId],
  );

  return useMemo(
    () => ({
      projectId,
      workId,
      selectedDraft,
      inlineReview,
      overlap,
      staleDraft,
      staleDraftMessage,
      isAccepting,
      isRejecting,
      isPending,
      isInlineDiscardPending,
      pendingInlineDiscardIds,
      confirmingAcceptOperationId,
      confirmingDiscardOperationId,
      inlineReviewMessage,
      inlineDiscardError,
      isOperationAccepting,
      isOperationUndoing,
      openReview,
      closeReview,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      fallbackInlineReviewToPanel,
      inlineReviewModelUnavailable,
      inlineReviewModelAvailable,
      setInlineReviewRuntime,
      confirmAcceptOperation,
      cancelAcceptOperation,
      acceptOperation,
      undoAcceptOperation,
      confirmDiscardOperation,
      cancelDiscardOperation,
      discardOperation,
      accept,
      reject,
    }),
    [
      projectId,
      workId,
      selectedDraft,
      inlineReview,
      overlap,
      staleDraft,
      staleDraftMessage,
      isAccepting,
      isRejecting,
      isPending,
      isInlineDiscardPending,
      pendingInlineDiscardIds,
      confirmingAcceptOperationId,
      confirmingDiscardOperationId,
      inlineReviewMessage,
      inlineDiscardError,
      isOperationAccepting,
      isOperationUndoing,
      openReview,
      closeReview,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      fallbackInlineReviewToPanel,
      inlineReviewModelUnavailable,
      inlineReviewModelAvailable,
      setInlineReviewRuntime,
      confirmAcceptOperation,
      cancelAcceptOperation,
      acceptOperation,
      undoAcceptOperation,
      confirmDiscardOperation,
      cancelDiscardOperation,
      discardOperation,
      accept,
      reject,
    ],
  );
}

const ACCEPT_SYNC_WAIT_MS = 1500;

async function latestPreviewDraftRevisionToken(
  queryClient: QueryClient,
  projectId: string,
  workId: string,
  documentId: string,
  draftId: string,
): Promise<number> {
  const queryKey = projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId);
  const preview = await getDraftPreview(projectId, workId, documentId, draftId);
  queryClient.setQueryData(queryKey, preview);
  return preview.status === "active" ? preview.draftRevisionToken : -1;
}

async function waitForDraftDocumentSync(draftId: string): Promise<void> {
  const registry = getDocumentSessionRegistry();
  const roomKey = draftRoomName(draftId);
  if (!registry.has(roomKey)) return;
  const session = registry.getRoom(roomKey);
  if (session.getSnapshot().status === "synced") return;
  await session.waitForCurrentSync(ACCEPT_SYNC_WAIT_MS);
}

function clearPendingDiscardTimer(
  timers: Map<string, number>,
  draftId: string,
  operationId: string,
): void {
  const key = discardTimerKey(draftId, operationId);
  const timer = timers.get(key);
  if (timer == null) return;
  window.clearTimeout(timer);
  timers.delete(key);
}

function discardTimerKey(draftId: string, operationId: string): string {
  return `${draftId}:${operationId}`;
}

function messageForRejectOutcome(outcome: InlineReviewRejectOutcome): string {
  switch (outcome.status) {
    case "stale":
      return "Couldn't discard — your latest edits are still syncing. Try again in a moment.";
    case "finalized":
      return "Couldn't discard — this draft may have been finalized.";
    case "offline":
      return "Couldn't discard. Check your connection and try again.";
    default:
      return "Couldn't discard. Try again.";
  }
}
