import type {
  ListTurnLiveLineageResponse,
  TurnLiveLineageDocumentItem,
  TurnReceiptChip,
} from "@meridian/contracts/protocol";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/core";
import { useEffect } from "react";

import { listTurnLiveLineage } from "@/client/api/live-lineage-api";
import { useIsThreadPendingCreation } from "@/client/stores";

import type { ListQueryStatus } from "./list-query";
import { threadQueryKeys } from "./thread-query-keys";

export function refreshTurnCards(queryClient: QueryClient, documentId?: string): Promise<void> {
  return queryClient.invalidateQueries(
    {
      predicate: ({ queryKey, state }) =>
        queryKey[0] === threadQueryKeys.all[0] &&
        queryKey[2] === "live-lineage" &&
        (documentId === undefined ||
          (state.data as ListTurnLiveLineageResponse | undefined)?.documents.some(
            (item) => item.documentId === documentId,
          ) === true),
    },
    { cancelRefetch: false },
  );
}

export function useRefreshTurnCardsOnEdit(editor: Editor | null, documentId: string): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!editor) return;
    let timer: number | null = null;
    const onUpdate = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void refreshTurnCards(queryClient, documentId);
      }, 300);
    };
    editor.on("update", onUpdate);
    return () => {
      if (timer != null) window.clearTimeout(timer);
      editor.off("update", onUpdate);
    };
  }, [editor, queryClient, documentId]);
}

export type TurnLiveLineageStatus = ListQueryStatus<TurnLiveLineageDocumentItem> & {
  documents: TurnLiveLineageDocumentItem[] | null;
  receipt: TurnReceiptChip | null;
  readAt: number;
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
      readAt: 0,
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
    readAt: query.dataUpdatedAt,
  };
}
