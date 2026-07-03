/**
 * useDraftPreview — live markdown plus active AI draft preview for a document.
 */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { useQuery } from "@tanstack/react-query";

import { getDraftPreview } from "@/client/api/drafts-api";
import { projectQueryKeys } from "./project-query-keys";

export type DraftPreviewState = {
  preview: DraftPreviewResponse | null;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
};

export function useDraftPreview(
  projectId: string | null,
  workId: string | null,
  documentId: string | null,
  draftId: string | null,
  options?: { enabled?: boolean; surface?: "inline" },
): DraftPreviewState {
  const callerEnabled = options?.enabled ?? true;
  const enabled =
    callerEnabled &&
    Boolean(projectId) &&
    Boolean(workId) &&
    Boolean(documentId) &&
    Boolean(draftId);
  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: projectQueryKeys.workDraftPreview(
      projectId ?? "",
      workId ?? "",
      documentId ?? "",
      draftId ?? "",
      options?.surface ?? null,
    ),
    queryFn: () =>
      getDraftPreview(
        projectId as string,
        workId as string,
        documentId as string,
        draftId as string,
        {
          surface: options?.surface,
        },
      ),
    staleTime: 15_000,
    enabled,
  });

  return {
    preview: data ?? null,
    isError,
    isFetching,
    refetch: () => {
      void refetch();
    },
  };
}
