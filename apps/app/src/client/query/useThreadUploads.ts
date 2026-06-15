import type { ThreadUploadDocumentItem } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { getThreadUploads } from "@/client/api/threads-api";
import { useIsThreadPendingCreation } from "@/client/stores";

import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { threadQueryKeys } from "./thread-query-keys";

/**
 * Files the user uploaded into this thread (the Chat right rail's
 * **Uploads** section). Backed by `GET /api/threads/:threadId/uploads`,
 * which projects `thread_documents` rows where the relationship is an
 * upload.
 *
 * Returns a {@link ListQueryStatus} so callers can drive UI honestly off
 * `status` (loading/empty/ready/error/disabled) instead of inferring it
 * from `array.length` — a normalized `[]` on error would otherwise be
 * indistinguishable from a real empty list.
 *
 * Suppressed while the thread is still pending optimistic server creation
 * (mirrors `useThreadSnapshotSync`) — otherwise the request races
 * `POST /api/threads` and produces a benign 404 / error UI during a normal
 * flow. `disabled` status surfaces when `threadId` is null or the thread is
 * pending creation.
 */
export type ThreadUploadsStatus = ListQueryStatus<ThreadUploadDocumentItem> & {
  uploads: ThreadUploadDocumentItem[] | null;
};

export function useThreadUploads(
  threadId: string | null,
  options?: { enabled?: boolean },
): ThreadUploadsStatus {
  const callerEnabled = options?.enabled ?? true;
  const isPendingCreation = useIsThreadPendingCreation(threadId);
  const enabled = callerEnabled && Boolean(threadId) && !isPendingCreation;
  const result = unwrapListQuery(
    useQuery({
      queryKey: threadQueryKeys.uploads(threadId ?? ""),
      queryFn: () => getThreadUploads(threadId as string),
      staleTime: 15_000,
      enabled,
    }),
  );

  // When the query is disabled (no thread / pending creation), surface a
  // dedicated `disabled` status so the UI hides counts and renders a
  // disabled-state hint rather than a misleading "empty" zero.
  if (!enabled) {
    return {
      ...result,
      data: null,
      status: "disabled",
      uploads: null,
    };
  }
  return { ...result, uploads: result.data };
}
