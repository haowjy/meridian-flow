/**
 * useDraftReviewMutations — Apply/Discard actions for Work drafts.
 */

import type {
  DraftApplyChangesRequest,
  DraftApplyChangesResponse,
  DraftDiscardRequest,
  DraftDiscardResponse,
  DraftPreviewResponse,
  ThreadDraftListItem,
} from "@meridian/contracts/drafts";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";

import { applyDraft, applyDraftChanges, discardDraft } from "@/client/api/drafts-api";
import { httpErrorStatus } from "@/client/api/http-client";
import {
  type ChangeCommandMode,
  type ChangeRef,
  confirmChangeCommand,
  previewWithoutOperations,
} from "./change-command-record";
import { confirmDraftCommand } from "./draft-command-record";
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
  /** A selective Discard: the changes' operation ids and the revision tokens of the preview the writer saw. */
  request?: Omit<DraftDiscardRequest, "draftId">;
  /**
   * Called with the server's answer the moment it arrives, before the list and
   * preview re-reads that follow. A surface that must act on the answer before
   * those caches move (the review settling because the server closed the draft)
   * cannot wait for the mutation to resolve: that waits for the re-reads.
   */
  onAnswered?: (response: DraftDiscardResponse) => void;
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
 * Apply is done when the server confirms it: the confirmed draft leaves cached
 * pending membership at once, and everything else refreshes in the background.
 * A rejection throws as is. A response that never arrived throws the distinct
 * unknown outcome; nothing here guesses from what the list later shows.
 */
export function useApplyDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (variables: DraftApplyMutationInput): Promise<void> => {
      const draftsKey = projectQueryKeys.workDrafts(variables.projectId, variables.workId);
      void queryClient.cancelQueries({ queryKey: draftsKey });
      try {
        await applyDraft(variables.projectId, variables.workId, variables.documentId, {
          draftId: variables.draftId,
        });
      } catch (error) {
        void invalidateDraftReviewQueries(queryClient, variables).catch(() => undefined);
        if (httpErrorStatus(error) !== undefined) throw error;
        throw new DraftApplyOutcomeUnknownError();
      }
      confirmDraftCommand(variables);
      queryClient.setQueryData<ThreadDraftListItem[]>(draftsKey, (drafts) =>
        drafts?.filter((draft) => draft.draftId !== variables.draftId),
      );
      void Promise.all([
        queryClient.invalidateQueries({
          predicate: (query) => isProjectContextCatalogKey(query.queryKey, variables.projectId),
        }),
        invalidateDraftReviewQueries(queryClient, variables),
      ]).catch(() => undefined);
    },
  });
}

export function useDiscardDraft() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      projectId,
      workId,
      documentId,
      draftId,
      request,
      onAnswered,
    }: DraftReviewMutationInput) => {
      const response = await discardDraft(projectId, workId, documentId, {
        draftId,
        ...(request?.operationIds?.length ? request : {}),
      });
      onAnswered?.(response);
      return response;
    },
    onSuccess: (_response, variables) => invalidateDraftReviewQueries(queryClient, variables),
    onError: (_error, variables) => invalidateDraftReviewQueries(queryClient, variables),
  });
}

export type DraftChangesApplyInput = DraftReviewMutationBase & {
  request: Omit<DraftApplyChangesRequest, "draftId">;
  /** See `DraftReviewMutationInput.onAnswered`. */
  onAnswered?: (response: DraftApplyChangesResponse) => void;
};

/**
 * Apply complete changes (server closure classes) of one draft. The server's
 * answer is data, not an error: a refusal (`stale`, `gone`, ...) resolves, and
 * the caller decides what it means. A rejection with a status throws as is; a
 * request that got no answer throws the distinct unknown outcome, as Apply does. Either way the draft's list and preview
 * are re-read before the mutation settles, so the surfaces that act next read
 * current tokens.
 */
export function useApplyDraftChanges() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      projectId,
      workId,
      documentId,
      draftId,
      request,
      onAnswered,
    }: DraftChangesApplyInput) => {
      let response: DraftApplyChangesResponse;
      try {
        response = await applyDraftChanges(projectId, workId, documentId, {
          draftId,
          ...request,
        });
      } catch (error) {
        // No answer is not a refusal: the change may have landed.
        if (httpErrorStatus(error) !== undefined) throw error;
        throw new DraftApplyOutcomeUnknownError();
      }
      onAnswered?.(response);
      return response;
    },
    onSuccess: (_response, variables) => invalidateDraftReviewQueries(queryClient, variables),
    onError: (_error, variables) => invalidateDraftReviewQueries(queryClient, variables),
  });
}

/**
 * The server confirmed one change (applied, or discarded): it leaves the cached
 * preview now, and preview reads already in flight can no longer bring it back.
 */
export function settleConfirmedChange(
  queryClient: QueryClient,
  draft: DraftReviewMutationBase,
  change: ChangeRef,
  mode: ChangeCommandMode,
): void {
  const hidden = new Set(change.operationIds);
  queryClient.setQueryData<DraftPreviewResponse>(
    projectQueryKeys.workDraftPreview(
      draft.projectId,
      draft.workId,
      draft.documentId,
      draft.draftId,
    ),
    (preview) => (preview ? previewWithoutOperations(preview, hidden) : preview),
  );
  confirmChangeCommand(draft, change, mode);
}
