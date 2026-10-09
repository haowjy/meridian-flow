/**
 * The thread a project destination shows, resolved with the semantics the chat
 * itself uses: the primary-chat list first, then the thread's own snapshot.
 *
 * The list holds primary chats only, so a subagent is never in it; the chat
 * screen renders one from its snapshot, and anything that must agree with what
 * is on screen (the Scratch the writer can browse) has to read the same two
 * places. The snapshot is read from the cache the chat's own sync fills; this
 * hook never fetches.
 */
import type { Thread } from "@meridian/contracts/protocol";
import { skipToken, useQuery } from "@tanstack/react-query";

import type { deserializeThreadSnapshot } from "@/client/api/threads-api";
import { threadQueryKeys } from "./thread-query-keys";
import { useProjectThreads } from "./useProjectThreads";

export function useDisplayedThread(projectId: string, threadId: string | null): Thread | null {
  const { threads } = useProjectThreads(projectId);
  const snapshotThread = useQuery({
    queryKey: threadQueryKeys.snapshot(threadId ?? ""),
    queryFn: skipToken,
    select: (snapshot: ReturnType<typeof deserializeThreadSnapshot>) => snapshot.thread,
  }).data;
  if (!threadId) return null;
  return threads?.find((candidate) => candidate.id === threadId) ?? snapshotThread ?? null;
}
