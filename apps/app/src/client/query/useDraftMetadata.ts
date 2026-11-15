/** Addressed SQL metadata only. Empty active drafts remain open independently of the pending list. */
import type { DraftMetadataResponse } from "@meridian/contracts/branches";
import { type QueryClient, useQueries } from "@tanstack/react-query";
import { getDraftMetadata } from "@/client/api/branches-api";
import type { DraftRef } from "@/features/draft-review/review-command-types";
import { projectQueryKeys } from "./project-query-keys";

export function draftMetadataQueryOptions(draft: DraftRef) {
  return {
    queryKey: projectQueryKeys.ownerDraftMetadata(
      draft.projectId,
      draft.ownerKey,
      draft.documentId,
      draft.itemKey,
    ),
    queryFn: ({ signal }: { signal: AbortSignal }) => getDraftMetadata(draft, signal),
    staleTime: 15_000,
  };
}
export function useDraftMetadata(drafts: readonly DraftRef[]) {
  return useQueries({ queries: drafts.map(draftMetadataQueryOptions) });
}

/**
 * A read that starts now, so it cannot report a disposition older than the question. It goes to
 * the server, not through the cached query: a restore or a wake hint invalidates that query, and
 * the refetch would cancel a read joined to it, which callers would take as no answer.
 */
export async function fetchCurrentDraftMetadata(
  queryClient: QueryClient,
  draft: DraftRef,
): Promise<DraftMetadataResponse> {
  const answer = await getDraftMetadata(draft);
  queryClient.setQueryData(draftMetadataQueryOptions(draft).queryKey, answer);
  return answer;
}
