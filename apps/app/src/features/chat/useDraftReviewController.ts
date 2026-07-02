/**
 * useDraftReviewController — shared state machine for reviewing AI document drafts.
 *
 * Cards and the preview overlay both let the writer apply or discard a draft;
 * this controller keeps those paths on one accept/reject flow so overlap
 * confirmation and overlay cleanup cannot drift between surfaces.
 */

import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useReducer, useRef, useState } from "react";
import { getDraftPreview } from "@/client/api/drafts-api";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { useAcceptDraft, useRejectDraft } from "@/client/query/useDraftReviewMutations";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";

import {
  acceptIsBlocked,
  type DraftReviewOverlap,
  type DraftReviewSelection,
  discardCanStart,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  type InlineDraftReview,
  inlineDiscardIsPending,
  inlineReviewFromState,
  pendingDiscardIdsForDraft,
  selectedDraftFromState,
} from "./draft-review-controller-transitions";

export type { DraftReviewOverlap, DraftReviewSelection, InlineDraftReview };

export type DraftReviewOpenOptions = {
  requireOverlapConfirm?: boolean;
  liveRevisionToken?: number;
};

export type DraftReviewController = {
  threadId: string;
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
  startInlineDiscard: (draftId: string, operationId: string) => boolean;
  settleInlineDiscard: (draftId: string, operationId: string) => void;
  openReview: (documentId: string, draftId: string, options?: DraftReviewOpenOptions) => void;
  closeReview: () => void;
  enterInlineReview: (documentId: string, draftId: string) => void;
  exitInlineReview: () => void;
  exitReview: () => void;
  fallbackInlineReviewToPanel: (documentId: string, draftId: string) => void;
  accept: (
    documentId: string,
    draftId: string,
    options?: { confirmedLiveRevisionToken?: number; draftRevisionToken?: number },
  ) => void;
  reject: (documentId: string, draftId: string) => void;
  acceptAll: (documentId: string, draftIds: readonly string[]) => void;
  rejectAll: (documentId: string, draftIds: readonly string[]) => void;
};

export function useDraftReviewController(threadId: string): DraftReviewController {
  const queryClient = useQueryClient();
  const acceptMutation = useAcceptDraft();
  const rejectMutation = useRejectDraft();
  const [state, dispatch] = useReducer(draftReviewReducer, EMPTY_DRAFT_REVIEW_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [isBatchPending, setIsBatchPending] = useState(false);

  const selectedDraft = selectedDraftFromState(state);
  const inlineReview = inlineReviewFromState(state);
  const overlap = state.overlap;
  const staleDraft = state.staleDraft;
  const isInlineDiscardPending = inlineDiscardIsPending(state);

  const staleDraftMessage = staleDraft
    ? "The draft changed — review the latest changes before applying."
    : null;
  const isAccepting = acceptMutation.isPending;
  const isRejecting = rejectMutation.isPending;
  const isPending = isAccepting || isRejecting || isBatchPending;

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

  const pendingInlineDiscardIds = useCallback(
    (draftId: string | null | undefined) => pendingDiscardIdsForDraft(stateRef.current, draftId),
    [],
  );

  const startInlineDiscard = useCallback((draftId: string, operationId: string) => {
    if (!discardCanStart(stateRef.current, draftId)) return false;
    dispatch({ type: "discardStarted", draftId, operationId });
    return true;
  }, []);

  const settleInlineDiscard = useCallback((draftId: string, operationId: string) => {
    dispatch({ type: "discardSettled", draftId, operationId });
  }, []);

  const accept = useCallback(
    async (
      documentId: string,
      draftId: string,
      options?: { confirmedLiveRevisionToken?: number; draftRevisionToken?: number },
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
      await waitForLiveDocumentSync(documentId);
      const draftRevisionToken =
        options?.draftRevisionToken ??
        (await latestPreviewDraftRevisionToken(queryClient, threadId, documentId, draftId));
      acceptMutation.mutate(
        {
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
            if (response.status === "stale_draft") {
              void queryClient.invalidateQueries({
                queryKey: threadQueryKeys.draftPreview(threadId, documentId, draftId, null),
              });
              void queryClient.invalidateQueries({
                queryKey: threadQueryKeys.draftPreview(threadId, documentId, draftId, "inline"),
              });
            }
            dispatch({ type: "applySucceeded", documentId, draftId, response });
          },
        },
      );
    },
    [acceptMutation, isPending, overlap, queryClient, threadId],
  );

  const reject = useCallback(
    (documentId: string, draftId: string) => {
      if (isPending) return;
      rejectMutation.mutate(
        { threadId, documentId, draftId },
        {
          onSuccess() {
            dispatch({ type: "rejectSucceeded", draftId });
          },
        },
      );
    },
    [isPending, rejectMutation, threadId],
  );

  const acceptAll = useCallback(
    async (documentId: string, draftIds: readonly string[]) => {
      if (
        draftIds.length === 0 ||
        acceptIsBlocked({
          isPending,
          isInlineDiscardPending: inlineDiscardIsPending(stateRef.current),
        })
      ) {
        return;
      }
      setIsBatchPending(true);
      try {
        for (const draftId of draftIds) {
          await waitForLiveDocumentSync(documentId);
          const draftRevisionToken = await latestPreviewDraftRevisionToken(
            queryClient,
            threadId,
            documentId,
            draftId,
          );
          const response = await acceptMutation.mutateAsync({
            threadId,
            documentId,
            draftId,
            draftRevisionToken,
          });
          dispatch({ type: "applySucceeded", documentId, draftId, response });
          if (response.status === "stale_draft") {
            void queryClient.invalidateQueries({
              queryKey: threadQueryKeys.draftPreview(threadId, documentId, draftId, null),
            });
            return;
          }
          if (response.status === "overlap") return;
        }
      } catch {
        // Mutation state carries the failure; the batch simply stops at the first error.
      } finally {
        setIsBatchPending(false);
      }
    },
    [acceptMutation, isPending, queryClient, threadId],
  );

  const rejectAll = useCallback(
    async (documentId: string, draftIds: readonly string[]) => {
      if (isPending || draftIds.length === 0) return;
      setIsBatchPending(true);
      try {
        for (const draftId of draftIds) {
          await rejectMutation.mutateAsync({ threadId, documentId, draftId });
          dispatch({ type: "rejectSucceeded", draftId });
        }
      } catch {
        // Mutation state carries the failure; the batch simply stops at the first error.
      } finally {
        setIsBatchPending(false);
      }
    },
    [isPending, rejectMutation, threadId],
  );

  return useMemo(
    () => ({
      threadId,
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
      startInlineDiscard,
      settleInlineDiscard,
      openReview,
      closeReview,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      fallbackInlineReviewToPanel,
      accept,
      reject,
      acceptAll,
      rejectAll,
    }),
    [
      threadId,
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
      startInlineDiscard,
      settleInlineDiscard,
      openReview,
      closeReview,
      enterInlineReview,
      exitInlineReview,
      exitReview,
      fallbackInlineReviewToPanel,
      accept,
      reject,
      acceptAll,
      rejectAll,
    ],
  );
}

const ACCEPT_SYNC_WAIT_MS = 1500;

async function latestPreviewDraftRevisionToken(
  queryClient: QueryClient,
  threadId: string,
  documentId: string,
  draftId: string,
): Promise<number> {
  const preview = await queryClient.ensureQueryData({
    queryKey: threadQueryKeys.draftPreview(threadId, documentId, draftId, null),
    queryFn: () => getDraftPreview(threadId, documentId, draftId),
  });
  return preview.status === "active" ? preview.draftRevisionToken : -1;
}

async function waitForLiveDocumentSync(documentId: string): Promise<void> {
  const registry = getDocumentSessionRegistry();
  if (!registry.has(documentId)) return;
  const session = registry.get(documentId);
  if (session.getSnapshot().status === "synced") return;
  await session.waitForCurrentSync(ACCEPT_SYNC_WAIT_MS);
}
