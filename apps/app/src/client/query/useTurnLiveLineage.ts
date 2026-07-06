/** useTurnLiveLineage — edited-document lineage and receipt state for one transcript turn. */
import type {
  ListTurnLiveLineageResponse,
  TurnLiveLineageDocumentItem,
  TurnReceiptChip,
} from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { listTurnLiveLineage } from "@/client/api/live-lineage-api";
import { useIsThreadPendingCreation } from "@/client/stores";

import type { ListQueryStatus } from "./list-query";
import { threadQueryKeys } from "./thread-query-keys";

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
