/**
 * useDraftPreview — live markdown plus active AI draft preview for a document.
 */
import type { DraftPreviewResponse } from "@meridian/contracts/drafts";
import { useQuery } from "@tanstack/react-query";

import { getDraftPreview } from "@/client/api/drafts-api";
import { useIsThreadPendingCreation } from "@/client/stores";

import { threadQueryKeys } from "./thread-query-keys";

export type DraftPreviewStatus = {
  data: DraftPreviewResponse | null;
  draft: DraftPreviewResponse["draft"] | null;
  live: string | null;
  previewMarkdown: string | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
};

export function useDraftPreview(
  threadId: string | null,
  documentId: string | null,
  options?: { enabled?: boolean },
): DraftPreviewStatus {
  const callerEnabled = options?.enabled ?? true;
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  const enabled = callerEnabled && Boolean(threadId) && Boolean(documentId) && !isPendingCreation;
  const { data, isError, isFetching, refetch } = useQuery({
    queryKey: threadQueryKeys.draftPreview(threadId ?? "", documentId ?? ""),
    queryFn: () => getDraftPreview(threadId as string, documentId as string),
    staleTime: 15_000,
    enabled,
  });

  return {
    data: data ?? null,
    draft: data?.draft ?? null,
    live: data?.live ?? null,
    previewMarkdown: data?.preview ?? null,
    isError,
    isFetching,
    refetch: () => {
      void refetch();
    },
  };
}
