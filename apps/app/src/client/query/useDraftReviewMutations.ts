/**
 * useDraftReviewMutations — accept/reject actions for AI document drafts.
 */
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";

import {
  acceptDraft,
  rejectDraft,
  undoAcceptDraft,
  undoRejectDraft,
} from "@/client/api/drafts-api";

import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";

export type DraftReviewMutationInput = {
  threadId: string;
  documentId: string;
  draftId: string;
  draftRevisionToken?: number;
  confirmOverlap?: boolean;
  confirmedLiveRevisionToken?: number;
};

function invalidateDraftReviewQueries(
  queryClient: QueryClient,
  { threadId, documentId }: { threadId: string; documentId: string },
): void {
  void queryClient.invalidateQueries({ queryKey: threadQueryKeys.drafts(threadId) });
  void queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) });
  void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === projectQueryKeys.all[0] && query.queryKey[2] === "threads",
  });
  void queryClient.invalidateQueries({
    queryKey: ["threads", threadId, "documents", documentId, "draft"],
  });
}

export function useAcceptDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      threadId,
      documentId,
      draftId,
      draftRevisionToken,
      confirmOverlap,
      confirmedLiveRevisionToken,
    }: DraftReviewMutationInput) => {
      if (draftRevisionToken === undefined) {
        throw new Error("Draft revision token is required to accept a draft.");
      }
      return acceptDraft(threadId, documentId, {
        draftId,
        draftRevisionToken,
        ...(confirmOverlap ? { confirmOverlap } : {}),
        ...(confirmedLiveRevisionToken !== undefined ? { confirmedLiveRevisionToken } : {}),
      });
    },
    onSuccess: (_response, variables) => {
      invalidateDraftReviewQueries(queryClient, variables);
    },
    onError: (_error, variables) => {
      invalidateDraftReviewQueries(queryClient, variables);
    },
  });
}

export function useRejectDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ threadId, documentId, draftId }: DraftReviewMutationInput) =>
      rejectDraft(threadId, documentId, { draftId }),
    onSuccess: (_response, variables) => {
      invalidateDraftReviewQueries(queryClient, variables);
    },
    onError: (_error, variables) => {
      invalidateDraftReviewQueries(queryClient, variables);
    },
  });
}

export function useUndoDraftAccept() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      threadId,
      documentId,
      draftId,
    }: {
      threadId: string;
      documentId: string;
      draftId: string;
    }) => undoAcceptDraft(threadId, documentId, { draftId }),
    onSuccess: (_response, variables) => {
      invalidateDraftReviewQueries(queryClient, variables);
    },
    onError: (_error, variables) => {
      invalidateDraftReviewQueries(queryClient, variables);
    },
  });
}

export function useUndoDraftReject() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      threadId,
      documentId,
      draftId,
    }: {
      threadId: string;
      documentId: string;
      draftId: string;
    }) => undoRejectDraft(threadId, documentId, { draftId }),
    onSuccess: (_response, variables) => {
      invalidateDraftReviewQueries(queryClient, variables);
    },
    onError: (_error, variables) => {
      invalidateDraftReviewQueries(queryClient, variables);
    },
  });
}
