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
  projectId: string;
  workId: string;
  threadId?: string | null;
  documentId: string;
  draftId: string;
  draftRevisionToken?: number;
  confirmOverlap?: boolean;
  confirmedLiveRevisionToken?: number;
  operationIds?: string[];
  confirmedClosureOperationIds?: string[];
};

function invalidateDraftReviewQueries(
  queryClient: QueryClient,
  {
    projectId,
    workId,
    threadId,
    documentId,
  }: { projectId: string; workId: string; threadId?: string | null; documentId: string },
): void {
  void queryClient.invalidateQueries({ queryKey: projectQueryKeys.workDrafts(projectId, workId) });
  if (threadId) {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) });
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === projectQueryKeys.all[0] && query.queryKey[2] === "threads",
  });
  void queryClient.invalidateQueries({
    queryKey: ["projects", projectId, "works", workId, "documents", documentId, "draft"],
  });
}

export function useAcceptDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectId,
      workId,
      documentId,
      draftId,
      draftRevisionToken,
      confirmOverlap,
      confirmedLiveRevisionToken,
      operationIds,
      confirmedClosureOperationIds,
    }: DraftReviewMutationInput) => {
      if (draftRevisionToken === undefined) {
        throw new Error("Draft revision token is required to accept a draft.");
      }
      return acceptDraft(projectId, workId, documentId, {
        draftId,
        draftRevisionToken,
        ...(operationIds && operationIds.length > 0 ? { operationIds } : {}),
        ...(confirmOverlap ? { confirmOverlap } : {}),
        ...(confirmedLiveRevisionToken !== undefined ? { confirmedLiveRevisionToken } : {}),
        ...(confirmedClosureOperationIds && confirmedClosureOperationIds.length > 0
          ? { confirmedClosureOperationIds }
          : {}),
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
    mutationFn: ({ projectId, workId, documentId, draftId }: DraftReviewMutationInput) =>
      rejectDraft(projectId, workId, documentId, { draftId }),
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
      projectId,
      workId,
      documentId,
      draftId,
      writeId,
    }: {
      projectId: string;
      workId: string;
      threadId?: string | null;
      documentId: string;
      draftId: string;
      writeId?: string;
    }) =>
      undoAcceptDraft(projectId, workId, documentId, { draftId, ...(writeId ? { writeId } : {}) }),
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
      projectId,
      workId,
      documentId,
      draftId,
    }: {
      projectId: string;
      workId: string;
      threadId?: string | null;
      documentId: string;
      draftId: string;
    }) => undoRejectDraft(projectId, workId, documentId, { draftId }),
    onSuccess: (_response, variables) => {
      invalidateDraftReviewQueries(queryClient, variables);
    },
    onError: (_error, variables) => {
      invalidateDraftReviewQueries(queryClient, variables);
    },
  });
}
