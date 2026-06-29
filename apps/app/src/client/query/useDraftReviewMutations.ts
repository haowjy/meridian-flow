/**
 * useDraftReviewMutations — accept/reject actions for AI document drafts.
 */
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";

import { acceptDraft, rejectDraft } from "@/client/api/drafts-api";

import { threadQueryKeys } from "./thread-query-keys";

export type DraftReviewMutationInput = {
  threadId: string;
  documentId: string;
};

function invalidateDraftReviewQueries(
  queryClient: QueryClient,
  { threadId, documentId }: DraftReviewMutationInput,
): void {
  void queryClient.invalidateQueries({ queryKey: threadQueryKeys.drafts(threadId) });
  void queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) });
  void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  void queryClient.invalidateQueries({
    queryKey: threadQueryKeys.draftPreview(threadId, documentId),
  });
}

export function useAcceptDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ threadId, documentId }: DraftReviewMutationInput) =>
      acceptDraft(threadId, documentId),
    onSuccess: (_response, variables) => {
      invalidateDraftReviewQueries(queryClient, variables);
    },
  });
}

export function useRejectDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ threadId, documentId }: DraftReviewMutationInput) =>
      rejectDraft(threadId, documentId),
    onSuccess: (_response, variables) => {
      invalidateDraftReviewQueries(queryClient, variables);
    },
  });
}
