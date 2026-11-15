/** Addressed SQL metadata only. Empty active drafts remain open independently of the pending list. */
import type { DraftMetadataResponse } from "@meridian/contracts/branches";
import { type QueryClient, useQueries } from "@tanstack/react-query";
import { getDraftMetadata } from "@/client/api/branches-api";
import type { DraftRef } from "@/features/draft-review/review-command-types";
import { createdDraftMetadata } from "./created-drafts";
import { projectQueryKeys } from "./project-query-keys";
import { useOwnerDraftList } from "./useOwnerDrafts";

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
/**
 * One owner's drafts' metadata. A draft the owner's pending creates make answers from the list
 * (`useCreatedDrafts`) until the server has made it: the server may not have heard of the create.
 */
export function useDraftMetadata(drafts: readonly DraftRef[]) {
  const results = useQueries({ queries: drafts.map(draftMetadataQueryOptions) });
  const owner = drafts[0];
  const { created } = useOwnerDraftList(
    owner?.projectId ?? "",
    owner?.ownerKey ?? "",
    owner !== undefined,
  );
  return results.map((result, index) => {
    const item = created.find((row) => row.itemKey === drafts[index]?.itemKey);
    if (!item || result.data?.status === "active") return result;
    return {
      ...result,
      data: createdDraftMetadata(item),
      error: null,
      isError: false,
      status: "success",
    } as typeof result;
  });
}

/** A read that starts now, so it cannot report a disposition older than the question. */
export function fetchCurrentDraftMetadata(
  queryClient: QueryClient,
  draft: DraftRef,
): Promise<DraftMetadataResponse> {
  return queryClient.fetchQuery({ ...draftMetadataQueryOptions(draft), staleTime: 0 });
}
