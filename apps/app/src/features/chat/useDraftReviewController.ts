/**
 * useDraftReviewController — shared state machine for reviewing AI document drafts.
 *
 * Cards and the preview overlay both let the writer apply or discard a draft;
 * this controller keeps those paths on one accept/reject flow so overlap
 * confirmation and overlay cleanup cannot drift between surfaces.
 */

import { draftRoomName } from "@meridian/contracts/protocol";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useReducer, useRef } from "react";
import { getDraftPreview } from "@/client/api/drafts-api";
import { projectQueryKeys } from "@/client/query/project-query-keys";
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
};

export function useDraftReviewController(projectId: string, workId: string): DraftReviewController {
  const queryClient = useQueryClient();
  const acceptMutation = useAcceptDraft();
  const rejectMutation = useRejectDraft();
  const [state, dispatch] = useReducer(draftReviewReducer, EMPTY_DRAFT_REVIEW_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

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
            if (response.status === "stale_draft") {
              void queryClient.invalidateQueries({
                queryKey: projectQueryKeys.workDraftPreview(
                  projectId,
                  workId,
                  documentId,
                  draftId,
                  null,
                ),
              });
              void queryClient.invalidateQueries({
                queryKey: projectQueryKeys.workDraftPreview(
                  projectId,
                  workId,
                  documentId,
                  draftId,
                  "inline",
                ),
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
  const queryKey = projectQueryKeys.workDraftPreview(projectId, workId, documentId, draftId, null);
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
