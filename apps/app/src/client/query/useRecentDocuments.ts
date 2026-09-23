import type { RecentDocumentItem } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { listRecentDocuments } from "@/client/api/recent-documents-api";
import {
  type AccountRecentItem,
  applyServerRecentList,
  getAccountRecentsServerSnapshot,
  getAccountRecentsSnapshot,
  subscribeAccountRecents,
} from "@/client/recents";
import { accountQueryKeys } from "./account-query-keys";

export type RecentDocumentsStatus = {
  documents: AccountRecentItem[];
  status: "loading" | "empty" | "ready" | "error";
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

type RecentListFetch = {
  accountId: string;
  bindEpoch: number;
  documents: RecentDocumentItem[];
};

/**
 * This project's recently opened documents. The device record paints first,
 * including after reload. The server list adds other devices. A payload from
 * another account bind is ignored.
 */
export function useRecentDocuments(projectId: string): RecentDocumentsStatus {
  const local = useSyncExternalStore(
    subscribeAccountRecents,
    getAccountRecentsSnapshot,
    getAccountRecentsServerSnapshot,
  );
  const accountId = local.userId;
  const query = useQuery({
    queryKey: accountQueryKeys.recentDocuments(accountId ?? "", projectId),
    queryFn: ({ signal }) => fetchRecentList(accountId ?? "", projectId, signal),
    enabled: accountId !== null,
    staleTime: 0,
  });
  useEffect(() => {
    const fetched = query.data;
    if (!fetched || fetched.accountId !== accountId || fetched.bindEpoch !== local.bindEpoch)
      return;
    applyServerRecentList(accountId, projectId, fetched.documents, fetched.bindEpoch);
  }, [accountId, local.bindEpoch, projectId, query.data]);

  const documents = useMemo(
    () => (local.bound ? local.items.filter((item) => item.projectId === projectId) : []),
    [local, projectId],
  );
  const awaitingServer =
    !local.bound || (documents.length === 0 && (query.isPending || query.isFetching));
  const status =
    documents.length > 0 ? "ready" : query.isError ? "error" : awaitingServer ? "loading" : "empty";
  return {
    documents,
    status,
    isError: query.isError,
    isFetching: query.isFetching,
    refetch: () => {
      void query.refetch();
    },
  };
}

async function fetchRecentList(
  accountId: string,
  projectId: string,
  signal: AbortSignal,
): Promise<RecentListFetch> {
  const bindEpoch = getAccountRecentsSnapshot().bindEpoch;
  const documents = await listRecentDocuments(projectId, signal);
  if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  return { accountId, bindEpoch, documents };
}
