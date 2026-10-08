/**
 * Restore lifecycle shared by the receipt and tool row for one delete.
 * Pending is immediate; only the server can mark the lineage reversed.
 * Refusals stay on the caller, and both controls unlock for another attempt.
 */
import type { ListTurnLiveLineageResponse } from "@meridian/contracts/protocol";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";

import { type RestoreDeleteOutcome, restoreAgentDelete } from "@/client/api/restore-delete-api";
import { threadQueryKeys } from "./thread-query-keys";

/** `wId` identifies the exact delete in the lineage. */
export type RestoreDeleteInput = { turnId: string; documentId: string; wId: number };

export function useRestoreDeleteMutation(threadId: string, input: RestoreDeleteInput | null) {
  const queryClient = useQueryClient();
  const mutationKey = ["restore-delete", threadId, input?.turnId, input?.documentId, input?.wId];
  const pending = useIsMutating({ mutationKey, exact: true }) > 0;
  const mutation = useMutation<RestoreDeleteOutcome, Error, RestoreDeleteInput>({
    mutationKey,
    mutationFn: ({ turnId, documentId }) => restoreAgentDelete(threadId, { turnId, documentId }),
    onSuccess: async (outcome, restored) => {
      if (outcome !== "restored" && outcome !== "already_restored") return;
      const queryKey = threadQueryKeys.liveLineage(threadId, restored.turnId);
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<ListTurnLiveLineageResponse>(
        queryKey,
        (lineage) =>
          lineage && {
            ...lineage,
            namespaceChanges: lineage.namespaceChanges.map((change) =>
              change.kind === "delete" &&
              change.documentId === restored.documentId &&
              change.wId === restored.wId
                ? { ...change, status: "reversed" }
                : change,
            ),
          },
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) }),
  });
  return {
    ...mutation,
    isPending: pending || mutation.isPending,
    mutate: () => {
      if (!input || queryClient.isMutating({ mutationKey, exact: true }) > 0) return;
      mutation.mutate(input);
    },
  };
}
