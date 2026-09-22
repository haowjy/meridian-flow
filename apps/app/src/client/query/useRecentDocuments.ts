import type { RecentDocumentItem } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { listRecentDocuments } from "@/client/api/recent-documents-api";

import { accountQueryKeys } from "./account-query-keys";
import { type ListQueryStatus, unwrapListQuery } from "./list-query";

/**
 * Documents the writer recently opened in one project.
 * Backed by `GET /api/projects/{projectId}/recent-documents`.
 */
export type RecentDocumentsStatus = ListQueryStatus<RecentDocumentItem> & {
  documents: RecentDocumentItem[] | null;
};

export function useRecentDocuments(projectId: string): RecentDocumentsStatus {
  const result = unwrapListQuery(
    useQuery({
      queryKey: accountQueryKeys.recentDocuments(projectId),
      queryFn: () => listRecentDocuments(projectId),
      // Recents change as the writer opens things; never serve a stale list just
      // because the landing remounted. Recording also invalidates this key.
      staleTime: 0,
    }),
  );
  return { ...result, documents: result.data };
}
