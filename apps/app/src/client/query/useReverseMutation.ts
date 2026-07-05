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
} from "@/client/api/reverse-api";
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
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) });
      void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === projectQueryKeys.all[0] &&
          query.queryKey[2] === "works" &&
          (query.queryKey[4] === "drafts" || query.queryKey[6] === "draft"),
      });
    },
  });
}
