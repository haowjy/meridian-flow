import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  type ReverseTurnInput,
  reverseTurn,
  successfulWorkReversals,
} from "@/client/api/reverse-api";
import { projectQueryKeys } from "./project-query-keys";
import { threadQueryKeys } from "./thread-query-keys";
import { convergeWorkProjection } from "./work-projection-cache";
import { repairWorksSnapshot } from "./works-projection-acquisition";

export function useReverseTurnMutation(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ReverseTurnInput) => reverseTurn(threadId, input),
    onSuccess: (outcome) => {
      const reversals = successfulWorkReversals(outcome);
      if (reversals.length === 0) return;
      for (const { command, projectId } of reversals) {
        convergeWorkProjection(queryClient, {
          kind: "entity",
          projectId,
          operation: command,
        });
        void repairWorksSnapshot(queryClient, projectId);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
      void queryClient.invalidateQueries({
        predicate: (query) =>
          query.queryKey[0] === projectQueryKeys.all[0] &&
          query.queryKey[2] === "document-draft-hints",
      });
      return queryClient.invalidateQueries({
        queryKey: threadQueryKeys.liveLineageRoot(threadId),
      });
    },
  });
}
