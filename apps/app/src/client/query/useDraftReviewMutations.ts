/**
 * useDraftReviewMutations — Apply/Discard actions for Work drafts.
 */

import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";

import { applyDraft, discardDraft, listWorkDrafts } from "@/client/api/drafts-api";
import { httpErrorStatus } from "@/client/api/http-client";
import { isProjectContextCatalogKey, projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";

type DraftReviewMutationBase = {
  projectId: string;
  workId: string;
  threadId?: string | null;
  documentId: string;
  draftId: string;
};

export type DraftApplyMutationInput = DraftReviewMutationBase;

/**
 * The Apply request got no HTTP answer, so the server may or may not have
 * applied the draft. Distinct from a rejection, which has a status.
 */
export class DraftApplyOutcomeUnknownError extends Error {
  constructor() {
    super("Draft Apply outcome is unknown");
  }
}

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

/**
 * Apply is done when the server confirms it. A rejection throws as is. A lost
 * response is settled by reading the draft list once: the draft is gone
 * (applied) or still listed (not applied). If that read is lost too, the
 * outcome stays unknown and the next list refresh shows which it was.
 */
export function useApplyDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: DraftApplyMutationInput): Promise<void> => {
      void queryClient.cancelQueries({
        queryKey: projectQueryKeys.workDrafts(variables.projectId, variables.workId),
      });
      try {
        await applyDraft(variables.projectId, variables.workId, variables.documentId, {
          draftId: variables.draftId,
        });
      } catch (error) {
        void invalidateDraftReviewQueries(queryClient, variables).catch(() => undefined);
        if (httpErrorStatus(error) !== undefined) throw error;
        await settleLostApply(variables, error);
      }
      void Promise.all([
        queryClient.invalidateQueries({
          predicate: (query) => isProjectContextCatalogKey(query.queryKey, variables.projectId),
        }),
        invalidateDraftReviewQueries(queryClient, variables),
      ]).catch(() => undefined);
    },
  });
}

async function settleLostApply(variables: DraftApplyMutationInput, lost: unknown): Promise<void> {
  let drafts: ThreadDraftListItem[];
  try {
    drafts = (await listWorkDrafts(variables.projectId, variables.workId)).drafts;
  } catch {
    throw new DraftApplyOutcomeUnknownError();
  }
  if (drafts.some((draft) => draft.draftId === variables.draftId)) throw lost;
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
