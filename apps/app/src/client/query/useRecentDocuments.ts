import type { RecentDocumentItem } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { listRecentDocuments } from "@/client/api/recent-documents-api";

import { accountQueryKeys } from "./account-query-keys";
import { type ListQueryStatus, unwrapListQuery } from "./list-query";

/**
 * Documents the writer recently opened, account-global across projects.
 * Backed by `GET /api/account/recent-documents`.
 */
export type RecentDocumentsStatus = ListQueryStatus<RecentDocumentItem> & {
  documents: RecentDocumentItem[] | null;
};

export function useRecentDocuments(options?: {
  enabled?: boolean;
  limit?: number;
}): RecentDocumentsStatus {
  const enabled = options?.enabled ?? true;
  const result = unwrapListQuery(
    useQuery({
      queryKey: accountQueryKeys.recentDocuments(options?.limit),
      queryFn: () => listRecentDocuments({ limit: options?.limit }),
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
  return { ...result, documents: result.data };
}
