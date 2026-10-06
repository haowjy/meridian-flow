/**
 * useRestoreDeleteMutation — the writer restores a document the agent deleted
 * in a turn.
 *
 * Optimistic: the turn's lineage marks the delete reversed at once, so its row
 * reads as restored before the server answers. A refusal or a failed request
 * puts the delete back to applied; `not_applied` keeps it reversed, because
 * nothing in the turn is left to restore.
 */
import type { ListTurnLiveLineageResponse } from "@meridian/contracts/protocol";
import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";

import { type RestoreDeleteOutcome, restoreAgentDelete } from "@/client/api/restore-delete-api";
import { threadQueryKeys } from "./thread-query-keys";

/** `wId` names the delete's row in the cache; the server finds the turn's applied delete itself. */
export type RestoreDeleteInput = { turnId: string; documentId: string; wId: number };

export function useRestoreDeleteMutation(threadId: string) {
  const queryClient = useQueryClient();
  return useMutation<RestoreDeleteOutcome, Error, RestoreDeleteInput>({
    mutationFn: ({ turnId, documentId }) => restoreAgentDelete(threadId, { turnId, documentId }),
    onMutate: async (input) => {
      const key = threadQueryKeys.liveLineage(threadId, input.turnId);
      // A refetch landing after the optimistic write would show the delete
      // applied again until the server answers.
      await queryClient.cancelQueries({ queryKey: key });
      setDeleteStatus(queryClient, threadId, input, "reversed");
    },
    onSuccess: (outcome, input) => {
      if (outcome === "location_taken" || outcome === "folder_missing") {
        setDeleteStatus(queryClient, threadId, input, "active");
      }
    },
    onError: (_error, input) => {
      setDeleteStatus(queryClient, threadId, input, "active");
    },
    onSettled: () =>
      // The turn's receipt control may flip to Redo with the delete reversed.
      queryClient.invalidateQueries({ queryKey: threadQueryKeys.liveLineageRoot(threadId) }),
  });
}

function setDeleteStatus(
  queryClient: QueryClient,
  threadId: string,
  input: RestoreDeleteInput,
  status: "active" | "reversed",
) {
  queryClient.setQueryData<ListTurnLiveLineageResponse>(
    threadQueryKeys.liveLineage(threadId, input.turnId),
    (lineage) =>
      lineage && {
        ...lineage,
        namespaceChanges: lineage.namespaceChanges.map((change) =>
          change.kind === "delete" &&
          change.documentId === input.documentId &&
          change.wId === input.wId
            ? { ...change, status }
            : change,
        ),
      },
  );
}
