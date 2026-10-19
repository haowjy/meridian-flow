import { parseContextUri, sourceLocationFromContextUri } from "@meridian/contracts/context-uri";
import type { RecentDocumentItem } from "@meridian/contracts/protocol";
import { isProjectContextTreeScheme } from "@meridian/contracts/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { listRecentDocuments } from "@/client/api/recent-documents-api";
import {
  type AccountRecentItem,
  applyServerRecentList,
  getAccountRecentsServerSnapshot,
  getAccountRecentsSnapshot,
  subscribeAccountRecents,
} from "@/client/recents";
import { useAccountResourceProjection } from "@/features/project/context/account-feature-context";
import { accountQueryKeys } from "./account-query-keys";
import { recentDeletionRevision, recentDocumentIdentityIndex } from "./recent-document-identity";

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
  const { snapshot } = useAccountResourceProjection(projectId);
  const identities = useMemo(
    () => recentDocumentIdentityIndex(projectId, snapshot),
    [projectId, snapshot],
  );
  const deletionRevision = recentDeletionRevision(projectId, snapshot);
  const queryClient = useQueryClient();
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

  useEffect(() => {
    if (!accountId || deletionRevision === "" || deletionRevision === "[]") return;
    void queryClient.invalidateQueries({
      queryKey: accountQueryKeys.recentDocuments(accountId, projectId),
    });
  }, [accountId, deletionRevision, projectId, queryClient]);

  const documents = useMemo(() => {
    if (!local.bound) return [];
    // Items are newest first, so the first sighting of a resource is its latest open.
    const seen = new Set<string>();
    return local.items.flatMap((item) => {
      if (item.projectId !== projectId) return [];
      const identity = identities.get(item.documentId);
      if (identity === null) return [];
      const currentId = identity?.documentId ?? item.documentId;
      if (seen.has(currentId)) return [];
      seen.add(currentId);
      if (!identity) return [item];
      const parsed = parseContextUri(identity.path);
      return [
        {
          ...item,
          documentId: currentId,
          name: identity.name,
          address:
            parsed.ok && isProjectContextTreeScheme(parsed.value.scheme)
              ? {
                  kind: "document" as const,
                  scheme: parsed.value.scheme,
                  path: `/${sourceLocationFromContextUri(parsed.value)}`,
                }
              : item.address,
        },
      ];
    });
  }, [identities, local, projectId]);
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
