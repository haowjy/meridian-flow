/** A retained review room can find its draft even after the review unmounts. */
import type { QueryClient } from "@tanstack/react-query";
import { httpErrorStatus } from "@/client/api/http-client";
import { projectQueryKeys } from "@/client/query/project-query-keys";
import { draftPreviewQueryOptions } from "@/client/query/useDraftPreview";
import type { BranchRoomRef } from "@/core/editor/branch-room-pool";

export function reviewRoomRef(
  queryClient: QueryClient,
  draft: {
    projectId: string;
    workId: string;
    documentId: string;
    draftId: string;
  },
  roomKey: string,
): BranchRoomRef {
  return {
    roomKey,
    async currentRoom() {
      try {
        const preview = await queryClient.fetchQuery({
          ...draftPreviewQueryOptions(draft),
          staleTime: 0,
        });
        return preview.status === "active" ? preview.reviewRoomName : null;
      } catch (error) {
        if (httpErrorStatus(error) === 404) return null;
        throw error;
      }
    },
    async changed() {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: projectQueryKeys.workDrafts(draft.projectId, draft.workId),
        }),
        queryClient.invalidateQueries({
          queryKey: projectQueryKeys.workDraftPreview(
            draft.projectId,
            draft.workId,
            draft.documentId,
            draft.draftId,
          ),
        }),
      ]);
    },
  };
}
