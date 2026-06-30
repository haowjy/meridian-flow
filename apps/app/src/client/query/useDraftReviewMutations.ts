/**
 * useDraftReviewMutations — accept/reject actions for AI document drafts.
 */
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";

import { acceptDraft, rejectDraft } from "@/client/api/drafts-api";

import { threadQueryKeys } from "./thread-query-keys";

export type DraftReviewMutationInput = {
  threadId: string;
  documentId: string;
  draftId: string;
  confirmOverlap?: boolean;
  confirmedLiveRevisionToken?: number;
};

function invalidateDraftReviewQueries(
  queryClient: QueryClient,
  { threadId, documentId }: DraftReviewMutationInput,
): void {
  void queryClient.invalidateQueries({ queryKey: threadQueryKeys.drafts(threadId) });
  void queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) });
  void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
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
      confirmOverlap,
      confirmedLiveRevisionToken,
    }: DraftReviewMutationInput) =>
      acceptDraft(threadId, documentId, {
        draftId,
        ...(confirmOverlap ? { confirmOverlap } : {}),
        ...(confirmedLiveRevisionToken !== undefined ? { confirmedLiveRevisionToken } : {}),
      }),
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
