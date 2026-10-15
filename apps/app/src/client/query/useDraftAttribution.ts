/**
 * The attribution query: the AI edit parts pending in a draft with their owning conversations, the
 * project's user and the Undo-restoration links, which the classifier joins to the room's text. One query
 * per draft; the review runtime asks again when the set of review changes moves (a chat's new write adds a
 * change). A missing or stale answer only drops a name.
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
