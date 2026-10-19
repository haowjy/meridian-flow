/** Addressed SQL metadata only. Empty active drafts remain open independently of the pending list. */
import { useQueries } from "@tanstack/react-query";
import { getDraftMetadata } from "@/client/api/branches-api";
import type { DraftRef } from "@/features/draft-review/review-command-types";
import { projectQueryKeys } from "./project-query-keys";

export function draftMetadataQueryOptions(draft: DraftRef) {
  return {
    queryKey: projectQueryKeys.workDraftMetadata(
      draft.projectId,
      draft.workId,
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
