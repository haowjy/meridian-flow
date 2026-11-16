/** useTurnLiveLineage — edited-document lineage and receipt state for one transcript turn. */
import type {
  ListTurnLiveLineageResponse,
  TurnLiveLineageDocumentItem,
  TurnReceiptChip,
} from "@meridian/contracts/protocol";
import { type QueryClient, useQuery } from "@tanstack/react-query";

import { listTurnLiveLineage } from "@/client/api/live-lineage-api";
import { useIsThreadPendingCreation } from "@/client/stores";

import type { ListQueryStatus } from "./list-query";
import { threadQueryKeys } from "./thread-query-keys";

/**
 * The turn cards read what became of their drafted documents, and nothing pushes that to them:
 * every Apply or Discard (the writer's, a peer's, per change or whole) calls this. A read already
 * in flight is the one the writer waits on, so it is not restarted.
 */
export function refreshTurnCards(queryClient: QueryClient): Promise<void> {
  return queryClient.invalidateQueries(
    {
      predicate: ({ queryKey }) =>
        queryKey[0] === threadQueryKeys.all[0] && queryKey[2] === "live-lineage",
    },
    { cancelRefetch: false },
  );
}

export type TurnLiveLineageStatus = ListQueryStatus<TurnLiveLineageDocumentItem> & {
  documents: TurnLiveLineageDocumentItem[] | null;
  receipt: TurnReceiptChip | null;
};

export function useTurnLiveLineage(
  threadId: string | null,
  turnId: string | null,
  options?: { enabled?: boolean },
): TurnLiveLineageStatus {
  const callerEnabled = options?.enabled ?? true;
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  const enabled = callerEnabled && Boolean(threadId) && Boolean(turnId) && !isPendingCreation;
  const query = useQuery<ListTurnLiveLineageResponse>({
    queryKey: threadQueryKeys.liveLineage(threadId ?? "", turnId ?? ""),
    queryFn: () => listTurnLiveLineage(threadId as string, turnId as string),
    // The receipt chip is computed from the documents as they are now, so any edit to them (the
    // writer's, a peer's, another chat's turn) changes it and nothing pushes that change. A switch
    // inside the window refetches nothing; a later mount or a window focus reads again.
    staleTime: 15_000,
    enabled,
  });

  if (!enabled) {
    return {
      data: null,
      status: "disabled",
      isError: false,
      isFetching: false,
      refetch: () => undefined,
      documents: null,
      receipt: null,
    };
  }

  const documents = query.data?.documents ?? (query.isPending || query.isFetching ? null : []);
  return {
    data: documents,
    status: query.isError
      ? "error"
      : documents === null
        ? "loading"
        : documents.length === 0
          ? "empty"
          : "ready",
    isError: query.isError,
    isFetching: query.isFetching,
    refetch: () => {
      void query.refetch();
    },
    documents,
    receipt: query.data?.receipt ?? null,
  };
}
