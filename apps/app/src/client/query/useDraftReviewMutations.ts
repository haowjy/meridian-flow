/**
 * useDraftReviewMutations — Apply/Discard actions for Work drafts.
 */

import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";

import { applyDraft, discardDraft } from "@/client/api/drafts-api";
import { getDocumentSessionRegistry } from "@/core/editor/document-session-registry";

import { isProjectContextTreeKey, projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";

type DraftReviewMutationBase = {
  projectId: string;
  workId: string;
  threadId?: string | null;
  documentId: string;
  draftId: string;
};

export type DraftReviewMutationInput = DraftReviewMutationBase & {
  operationIds?: string[];
};

function invalidateDraftReviewQueries(
  queryClient: QueryClient,
  {
    projectId,
    workId,
    threadId,
    documentId,
  }: { projectId: string; workId: string; threadId?: string | null; documentId: string },
): Promise<void> {
  if (threadId) {
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) });
    void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
  }
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === projectQueryKeys.all[0] && query.queryKey[2] === "threads",
  });
  // Awaited: these two queries are the disposition state review UIs render
  // from. Returned from onSuccess/onError they hold the mutation isPending
  // until the refetch settles, so verbs re-enable only once the rows they act
  // on are current. Thread invalidations above stay fire-and-forget — they
  // don't gate disposition.
  return Promise.all([
    queryClient.invalidateQueries({
      queryKey: projectQueryKeys.workDrafts(projectId, workId),
    }),
    queryClient.invalidateQueries({
      queryKey: ["projects", projectId, "works", workId, "documents", documentId, "draft"],
    }),
  ]).then(() => undefined);
}

export function useApplyDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ projectId, workId, documentId, draftId }: DraftReviewMutationBase) =>
      applyDraft(projectId, workId, documentId, { draftId }),
    onSuccess: async (_response, variables) => {
      // A draft-only tab may have opened its live room before the document was
      // materialized, leaving a terminal authorization denial cached in the
      // registry. Apply grants access; replace only that unavailable session
      // so EditorView can bind a freshly authorized provider on review exit.
      await getDocumentSessionRegistry().restartUnavailableRoom(variables.documentId);
      void queryClient.invalidateQueries({
        predicate: (query) => isProjectContextTreeKey(query.queryKey, variables.projectId),
      });
      await invalidateDraftReviewQueries(queryClient, variables);
    },
    onError: (_error, variables) => invalidateDraftReviewQueries(queryClient, variables),
  });
}

export function useDiscardDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectId,
      workId,
      documentId,
      draftId,
      operationIds,
    }: DraftReviewMutationInput) =>
      discardDraft(projectId, workId, documentId, {
        draftId,
        ...(operationIds && operationIds.length > 0 ? { operationIds } : {}),
      }),
    onSuccess: (_response, variables) => invalidateDraftReviewQueries(queryClient, variables),
    onError: (_error, variables) => invalidateDraftReviewQueries(queryClient, variables),
  });
}
