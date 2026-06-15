import type { ThreadRecentDocumentItem } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { getThreadRecentDocuments } from "@/client/api/threads-api";
import { useIsThreadPendingCreation } from "@/client/stores";

import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { threadQueryKeys } from "./thread-query-keys";

/**
 * Documents the agent recently read/touched in this thread (the Chat right
 * rail's **Recent** section). Backed by
 * `GET /api/threads/:threadId/recent-documents`, projected from
 * `turn_document_touches` and deduped by document id.
 *
 * Returns a {@link ListQueryStatus} so callers can branch on `status`
 * (loading/empty/ready/error/disabled) instead of inferring it from
 * `array.length`. Suppressed while the thread is still pending optimistic
 * server creation; surfaces `disabled` when no thread is selected or while
 * the thread is being created server-side.
 */
export type ThreadRecentDocumentsStatus = ListQueryStatus<ThreadRecentDocumentItem> & {
  documents: ThreadRecentDocumentItem[] | null;
};

export function useThreadRecentDocuments(
  threadId: string | null,
  options?: { enabled?: boolean; limit?: number },
): ThreadRecentDocumentsStatus {
  const callerEnabled = options?.enabled ?? true;
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  const enabled = callerEnabled && Boolean(threadId) && !isPendingCreation;
  const result = unwrapListQuery(
    useQuery({
      queryKey: threadQueryKeys.recentDocuments(threadId ?? "", options?.limit),
      queryFn: () => getThreadRecentDocuments(threadId as string, { limit: options?.limit }),
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
