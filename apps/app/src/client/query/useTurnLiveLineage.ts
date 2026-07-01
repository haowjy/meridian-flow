/** useTurnLiveLineage — live document lineage for one undoable transcript turn. */
import type { TurnLiveLineageDocumentItem } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { listTurnLiveLineage } from "@/client/api/live-lineage-api";
import { useIsThreadPendingCreation } from "@/client/stores";

import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { threadQueryKeys } from "./thread-query-keys";

export type TurnLiveLineageStatus = ListQueryStatus<TurnLiveLineageDocumentItem> & {
  documents: TurnLiveLineageDocumentItem[] | null;
};

export function useTurnLiveLineage(
  threadId: string | null,
  turnId: string | null,
  options?: { enabled?: boolean },
): TurnLiveLineageStatus {
  const callerEnabled = options?.enabled ?? true;
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  const enabled = callerEnabled && Boolean(threadId) && Boolean(turnId) && !isPendingCreation;
  const result = unwrapListQuery(
    useQuery({
      queryKey: threadQueryKeys.liveLineage(threadId ?? "", turnId ?? ""),
      queryFn: async () => {
        const response = await listTurnLiveLineage(threadId as string, turnId as string);
        return response.documents;
      },
      staleTime: 15_000,
      enabled,
    }),
  );

  if (!enabled) {
    return {
      ...result,
      data: null,
      status: "disabled",
      documents: null,
    };
  }

  return {
    ...result,
    documents: result.data,
  };
}
