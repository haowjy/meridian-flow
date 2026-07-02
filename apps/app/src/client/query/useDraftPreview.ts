/**
 * useDraftPreview — live markdown plus active AI draft preview for a document.
 */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { useQuery } from "@tanstack/react-query";

import { getDraftPreview } from "@/client/api/drafts-api";
import { useIsThreadPendingCreation } from "@/client/stores";

import { threadQueryKeys } from "./thread-query-keys";

export type DraftPreviewState = {
  preview: DraftPreviewResponse | null;
  isFetching: boolean;
  isError: boolean;
  refetch: () => void;
};

export function useDraftPreview(
  threadId: string | null,
  documentId: string | null,
  draftId: string | null,
  options?: { enabled?: boolean; surface?: "inline" },
): DraftPreviewState {
  const callerEnabled = options?.enabled ?? true;
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  const enabled =
    callerEnabled &&
    Boolean(threadId) &&
    Boolean(documentId) &&
    Boolean(draftId) &&
    !isPendingCreation;
  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: threadQueryKeys.draftPreview(
      threadId ?? "",
      documentId ?? "",
      draftId ?? "",
      options?.surface ?? null,
    ),
    queryFn: () =>
      getDraftPreview(threadId as string, documentId as string, draftId as string, {
        surface: options?.surface,
      }),
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
