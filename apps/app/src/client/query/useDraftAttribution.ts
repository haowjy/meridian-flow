/**
 * AI edit parts with their owning conversations and the room revision they cover. The runtime refreshes
 * on item/deletion identity and provenance changes, not content hashes. Missing evidence is unresolved.
 */
import type { QueryFunctionContext } from "@tanstack/react-query";
import { getDraftAttribution } from "@/client/api/drafts-api";
import { projectQueryKeys } from "./project-query-keys";
import type { DraftMetaRef } from "./useDraftMeta";

export function draftAttributionQueryOptions(ref: DraftMetaRef) {
  return {
    queryKey: projectQueryKeys.workDraftAttribution(
      ref.projectId,
      ref.workId,
      ref.documentId,
      ref.itemKey,
    ),
    queryFn: ({ signal }: QueryFunctionContext) =>
      getDraftAttribution(ref.projectId, ref.workId, ref.documentId, ref.itemKey, signal),
    staleTime: 15_000,
  };
}
