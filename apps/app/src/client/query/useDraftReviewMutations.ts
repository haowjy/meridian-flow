/**
 * useDraftReviewMutations — Apply/Discard actions for Work drafts.
 */

import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";

import { applyDraft, discardDraft } from "@/client/api/drafts-api";
import { usePostApplyDispositionOwner } from "@/features/project/draft-apply-recovery/DraftApplyRecoveryProvider";
import type {
  ApplyExecutionResult,
  DraftRecoveryIdentity,
  DraftRecoveryObligations,
  DraftRecoveryPresentation,
} from "@/features/project/draft-apply-recovery/draft-apply-recovery-owner";
import { isProjectContextCatalogKey, projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";

type DraftReviewMutationBase = {
  projectId: string;
  workId: string;
  threadId?: string | null;
  documentId: string;
  draftId: string;
};

export type DraftApplyMutationInput = DraftReviewMutationBase & {
  identity: DraftRecoveryIdentity;
  presentation: DraftRecoveryPresentation;
  obligations: DraftRecoveryObligations;
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
  const owner = usePostApplyDispositionOwner();

  return useMutation({
    mutationFn: async (variables: DraftApplyMutationInput): Promise<ApplyExecutionResult> => {
      void queryClient.cancelQueries({
        queryKey: projectQueryKeys.workDrafts(variables.projectId, variables.workId),
      });
      const reserved = owner.reserveApply({
        identity: variables.identity,
        presentation: variables.presentation,
        obligations: variables.obligations,
      });
      if (reserved.kind === "existing")
        return { kind: "server-applied-awaiting-live", recovery: reserved.recovery };
      if (reserved.kind === "settled")
        return { kind: "server-applied-settled-elsewhere", outcome: reserved.outcome };
      if (reserved.kind === "blocked") throw new Error("Draft Apply is already pending");
      const acquired = owner.acquireApplyDispatch(reserved.unsent);
      if (acquired.kind === "existing")
        return { kind: "server-applied-awaiting-live", recovery: acquired.recovery };
      if (acquired.kind === "settled")
        return { kind: "server-applied-settled-elsewhere", outcome: acquired.outcome };
      if (acquired.kind === "stale") throw new Error("Draft Apply dispatch became stale");
      try {
        const response = await applyDraft(
          variables.projectId,
          variables.workId,
          variables.documentId,
          {
            draftId: variables.draftId,
          },
        );
        const promoted = owner.recordServerApplied({
          kind: "local-response",
          dispatch: acquired.dispatch,
          responseDraftId: response.draftId,
        });
        if (promoted.kind === "recorded" || promoted.kind === "existing") {
          void Promise.all([
            queryClient.invalidateQueries({
              predicate: (query) => isProjectContextCatalogKey(query.queryKey, variables.projectId),
            }),
            invalidateDraftReviewQueries(queryClient, variables),
          ]).catch(() => undefined);
          return { kind: "server-applied-awaiting-live", recovery: promoted.recovery };
        }
        if (promoted.kind === "already-settled")
          return { kind: "server-applied-settled-elsewhere", outcome: promoted.outcome };
        throw new Error("Draft Apply response could not be validated");
      } catch (error) {
        const unknown = owner.markApplyOutcomeUnknown(acquired.dispatch);
        void invalidateDraftReviewQueries(queryClient, variables).catch(() => undefined);
        if (unknown.kind === "outcome-unknown")
          return { kind: "apply-outcome-unknown", reservation: unknown.reservation };
        if (unknown.kind === "existing")
          return { kind: "server-applied-awaiting-live", recovery: unknown.recovery };
        if (unknown.kind === "settled")
          return { kind: "server-applied-settled-elsewhere", outcome: unknown.outcome };
        throw error;
      }
    },
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
