/**
 * useReverseMutation — React Query mutations for chat turn undo/redo.
 *
 * The editor is updated by server-side Yjs sync; the mutation refreshes the
 * turn lineage cache so transcript undo affordances reflect server state.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  type ReverseDocumentInput,
  type ReverseTurnInput,
  reverseDocument,
  reverseTurn,
  successfulWorkReversals,
} from "@/client/api/reverse-api";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import { convergeWorkProjection } from "./work-projection-cache";

export function useReverseDocumentMutation(threadId: string) {
  return useMutation({
    mutationFn: (input: ReverseDocumentInput) => reverseDocument(threadId, input),
  });
}

export function useReverseTurnMutation(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReverseTurnInput) => reverseTurn(threadId, input),
    onSuccess: (outcome) => {
      // A restored Work must reappear in the sidebar and rail without a
      // reload, so its project's works and thread bindings refetch together.
      const reversals = successfulWorkReversals(outcome);
      if (reversals.length === 0) return;
      for (const { command, projectId } of reversals) {
        convergeWorkProjection(queryClient, {
          kind: "entity",
          projectId,
          operation: command,
        });
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === projectQueryKeys.all[0] &&
          query.queryKey[2] === "works" &&
          (query.queryKey[4] === "drafts" || query.queryKey[6] === "draft"),
      });
      // The lineage receipt owns the Undo/Redo/View change affordance. Await
      // its refresh so an HTTP-200 refusal cannot settle against stale UI.
      return queryClient.invalidateQueries({
        queryKey: threadQueryKeys.liveLineageRoot(threadId),
      });
    },
  });
}
