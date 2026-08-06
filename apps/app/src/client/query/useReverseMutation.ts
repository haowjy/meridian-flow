/**
 * useReverseMutation — React Query mutations for chat turn undo/redo.
 *
 * The editor is updated by server-side Yjs sync; the mutation refreshes the
 * turn lineage cache so transcript undo affordances reflect server state.
 */
import type { ThreadSnapshotResponse } from "@meridian/contracts/protocol";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  type ReverseDocumentInput,
  type ReverseTurnInput,
  restoredWorks,
  reverseDocument,
  reverseTurn,
} from "@/client/api/reverse-api";
import { invalidateProjectThreadData } from "./project-invalidation";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";

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
      if (restoredWorks(outcome).length === 0) return;
      const projectId = queryClient.getQueryData<ThreadSnapshotResponse>(
        threadQueryKeys.snapshot(threadId),
      )?.thread.projectId;
      if (projectId) {
        void invalidateProjectThreadData(queryClient, projectId);
        return;
      }
      // Without a cached snapshot the owning project is unknown here; refresh
      // every project's caches rather than miss the restored Work.
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
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
