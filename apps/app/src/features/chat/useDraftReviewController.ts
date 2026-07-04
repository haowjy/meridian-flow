/**
 * useDraftReviewController — shared state machine for reviewing AI document drafts.
 *
 * Cards and the preview overlay both let the writer apply or discard a draft;
 * this controller keeps those paths on one accept/reject flow so overlap
 * confirmation and overlay cleanup cannot drift between surfaces.
 */

import type { DraftAcceptRequest } from "@meridian/contracts/drafts";
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
  cannotPlaceOperationIdsForDraft,
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
  pendingDiscardIdsSettledByPreview,
} from "./draft-review-controller-transitions";
import {
  type InlineReviewJournalCache,
  type InlineReviewRejectContext,
  type InlineReviewRejectOutcome,
  rejectInlineReviewOperation,
} from "./inline-review-discard-operation";

export type { DraftReviewOverlap, DraftReviewSelection, InlineDraftReview };

export type DraftReviewController = {
  projectId: string;
  workId: string;
  /** Focused thread owning this review surface; threads accept/reject/undo cache invalidation. */
  threadId: string | null;
  inlineReview: InlineDraftReview | null;
  overlap: DraftReviewOverlap | null;
  staleDraft: DraftReviewSelection | null;
  staleDraftMessage: string | null;
  /** Terminal placement failure for a whole draft in inline review. */
  cannotPlaceDraft: DraftReviewSelection | null;
  isAccepting: boolean;
  isRejecting: boolean;
  isPending: boolean;
  isInlineDiscardPending: boolean;
  pendingInlineDiscardIds: (draftId: string | null | undefined) => ReadonlySet<string>;
  cannotPlaceInlineOperationIds: (draftId: string | null | undefined) => ReadonlySet<string>;
  confirmingAcceptOperationId: string | null;
  confirmingDiscardOperationId: string | null;
  inlineReviewMessage: InlineReviewMessage | null;
  inlineDiscardError: string | null;
  isOperationAccepting: boolean;
  isOperationUndoing: boolean;
  enterInlineReview: (documentId: string, draftId: string) => void;
  exitInlineReview: () => void;
  exitReview: () => void;
  inlineReviewModelAvailable: (
    identity: string,
    documentId: string,
    draftId: string,
    operationIds: readonly string[],
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

export function useDraftReviewController(
  projectId: string,
  workId: string,
  threadId: string | null = null,
): DraftReviewController {
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

  const inlineReview = inlineReviewFromState(state);
  const overlap = state.overlap;
  const staleDraft = state.staleDraft;
  const cannotPlaceDraft = state.cannotPlaceDraft;
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

  const enterInlineReview = useCallback((documentId: string, draftId: string) => {
    dispatch({ type: "enterInline", documentId, draftId });
  }, []);

  const exitInlineReview = useCallback(() => {
    dispatch({ type: "exitInline" });
  }, []);

  const exitReview = useCallback(() => {
    dispatch({ type: "exitReview" });
  }, []);

  const inlineReviewModelAvailable = useCallback(
    (_identity: string, documentId: string, draftId: string, operationIds: readonly string[]) => {
      for (const operationId of pendingDiscardIdsSettledByPreview(stateRef.current, {
        documentId,
        draftId,
        operationIds,
      })) {
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
  const cannotPlaceInlineOperationIds = useCallback(
    (draftId: string | null | undefined) =>
      cannotPlaceOperationIdsForDraft(stateRef.current, draftId),
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
    async (operationId: string, model: InlineReviewModel) => {
      const current = stateRef.current;
      const inline = current.surface.kind === "inline" ? current.surface : null;
      if (!inline || operationAcceptMutation.isPending || undoAcceptMutation.isPending) return;
      const operation = model.operations.find((candidate) => candidate.operationId === operationId);
      if (!operation) return;
      const overlapConfirm = operationOverlapFor(current.overlap, inline.draftId, operationId);
      const confirmClosure = current.confirmingAcceptOperationId === operationId;
      dispatch({ type: "operationAcceptStarted" });
      let revisionTokens: DraftPreviewRevisionTokens;
      try {
        await waitForDraftDocumentSync(inline.draftId);
        revisionTokens = await latestPreviewRevisionTokens(
          queryClient,
          projectId,
          workId,
          inline.documentId,
          inline.draftId,
        );
      } catch {
        dispatch({
          type: "operationAcceptFailed",
          message: {
            text: "Couldn't accept. Check your connection and try again.",
            tone: "error",
          },
        });
        return;
      }
      const request = operationAcceptRequest({
        draftId: inline.draftId,
        draftRevisionToken: revisionTokens.draftRevisionToken,
        operationId,
        acceptClosureOperationIds: operation.acceptClosureOperationIds,
        liveRevisionToken: revisionTokens.liveRevisionToken ?? model.liveRevisionToken,
        confirmClosure,
        overlap: overlapConfirm,
      });
      operationAcceptMutation.mutate(
        {
          projectId,
          workId,
          threadId,
          documentId: inline.documentId,
          ...request,
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
              dispatch({
                type: "operationAcceptSucceeded",
                message: {
                  text: "This proposal depends on earlier AI changes. Accept the related changes first, or apply the whole draft.",
                },
              });
            } else if (response.status === "cannot_place") {
              dispatch({
                type: "operationCannotPlace",
                draftId: inline.draftId,
                operationId,
                message: {
                  text: "A proposal no longer lines up with the manuscript.",
                  tone: "info",
                },
              });
            } else if (response.status === "closure_confirmation_required") {
              if (confirmClosure) {
                dispatch({
                  type: "operationAcceptSucceeded",
                  message: {
                    text: "Draft changed — review the related proposals and confirm again.",
                  },
                });
              }
              dispatch({ type: "confirmAcceptOperation", operationId });
            } else if (response.status === "applied") {
              dispatch({
                type: "applySucceeded",
                documentId: inline.documentId,
                draftId: inline.draftId,
                response,
              });
            } else if (response.status === "overlap") {
              dispatch({
                type: "operationOverlapReturned",
                documentId: inline.documentId,
                overlap: {
                  draftId: response.draftId,
                  operationId,
                  liveRevisionToken: response.liveRevisionToken,
                  live: response.live,
                  preview: response.preview,
                },
              });
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
    [
      operationAcceptMutation,
      undoAcceptMutation.isPending,
      queryClient,
      projectId,
      workId,
      threadId,
    ],
  );

  const undoAcceptOperation = useCallback(() => {
    const inline = stateRef.current.surface.kind === "inline" ? stateRef.current.surface : null;
    const writeId = stateRef.current.inlineReviewMessage?.writeId;
    if (!inline || !writeId || undoAcceptMutation.isPending) return;
    undoAcceptMutation.mutate(
      {
        projectId,
        workId,
        threadId,
        documentId: inline.documentId,
        draftId: inline.draftId,
        writeId,
      },
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
            message: { text: "Couldn't undo that proposal. Nothing changed.", tone: "error" },
          });
        },
      },
    );
  }, [projectId, undoAcceptMutation, workId, threadId]);

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
            message: "That change is still in the draft. Try again before applying the draft.",
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
          isCannotPlaceTerminal:
            stateRef.current.cannotPlaceDraft?.documentId === documentId &&
            stateRef.current.cannotPlaceDraft.draftId === draftId,
        })
      ) {
        return;
      }
      const needsOverlapConfirm = overlap?.draftId === draftId;
      await waitForDraftDocumentSync(draftId);
      const { draftRevisionToken } = await latestPreviewRevisionTokens(
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
          threadId,
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
    [acceptMutation, isPending, overlap, queryClient, projectId, workId, threadId],
  );

  const reject = useCallback(
    (documentId: string, draftId: string) => {
      if (isPending) return;
      rejectMutation.mutate(
        { projectId, workId, threadId, documentId, draftId },
        {
          onSuccess() {
            dispatch({ type: "rejectSucceeded", draftId });
          },
        },
      );
    },
    [isPending, rejectMutation, projectId, workId, threadId],
  );

  return useMemo(
    () => ({
      projectId,
      workId,
      threadId,
      inlineReview,
      overlap,
      staleDraft,
      staleDraftMessage,
      cannotPlaceDraft,
      isAccepting,
      isRejecting,
      isPending,
      isInlineDiscardPending,
      pendingInlineDiscardIds,
      cannotPlaceInlineOperationIds,
      confirmingAcceptOperationId,
      confirmingDiscardOperationId,
      inlineReviewMessage,
      inlineDiscardError,
      isOperationAccepting,
      isOperationUndoing,
      enterInlineReview,
      exitInlineReview,
      exitReview,
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
      threadId,
      inlineReview,
      overlap,
      staleDraft,
      staleDraftMessage,
      cannotPlaceDraft,
      isAccepting,
      isRejecting,
      isPending,
      isInlineDiscardPending,
      pendingInlineDiscardIds,
      cannotPlaceInlineOperationIds,
      confirmingAcceptOperationId,
      confirmingDiscardOperationId,
      inlineReviewMessage,
      inlineDiscardError,
      isOperationAccepting,
      isOperationUndoing,
      enterInlineReview,
      exitInlineReview,
      exitReview,
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

type DraftPreviewRevisionTokens = { draftRevisionToken: number; liveRevisionToken: number | null };

async function latestPreviewRevisionTokens(
  queryClient: QueryClient,
  projectId: string,
  workId: string,
  documentId: string,
  draftId: string,
): Promise<DraftPreviewRevisionTokens> {
  const queryKey = projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId);
  const preview = await getDraftPreview(projectId, workId, documentId, draftId);
  queryClient.setQueryData(queryKey, preview);
  return preview.status === "active"
    ? {
        draftRevisionToken: preview.draftRevisionToken,
        liveRevisionToken: preview.liveRevisionToken,
      }
    : { draftRevisionToken: -1, liveRevisionToken: null };
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
      return "Couldn't discard — this draft may already be applied or discarded.";
    case "offline":
      return "Couldn't discard. Check your connection and try again.";
    default:
      return "Couldn't discard. Try again.";
  }
}

function operationAcceptRequest(input: {
  draftId: string;
  draftRevisionToken: number;
  operationId: string;
  acceptClosureOperationIds?: readonly string[];
  liveRevisionToken?: number;
  confirmClosure: boolean;
  overlap: DraftReviewOverlap | null;
}): DraftAcceptRequest {
  const closureOperationIds = input.acceptClosureOperationIds ?? [input.operationId];
  const confirmedClosureOperationIds = input.confirmClosure ? [...closureOperationIds] : undefined;
  return {
    draftId: input.draftId,
    draftRevisionToken: input.draftRevisionToken,
    operationIds: [input.operationId],
    confirmedClosureOperationIds,
    confirmOverlap: input.overlap != null ? true : undefined,
    confirmedLiveRevisionToken: input.overlap
      ? (input.liveRevisionToken ?? input.overlap.liveRevisionToken)
      : input.confirmClosure
        ? input.liveRevisionToken
        : undefined,
  };
}

function operationOverlapFor(
  overlap: DraftReviewOverlap | null,
  draftId: string,
  operationId: string,
): DraftReviewOverlap | null {
  return overlap?.draftId === draftId && overlap.operationId === operationId ? overlap : null;
}
