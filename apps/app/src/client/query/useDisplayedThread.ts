/**
 * The thread a project destination shows, resolved with the semantics the chat
 * itself uses: the primary-chat list first, then the thread's own snapshot.
 *
 * The list holds primary chats only, so a subagent is never in it; the chat
 * screen renders one from its snapshot, and anything that must agree with what
 * is on screen (the Scratch the writer can browse) has to read the same two
 * places. The snapshot is read from the cache the chat's own sync fills, without
 * an observer: this hook never fetches and never touches the host's options.
 */
import type { Thread } from "@meridian/contracts/protocol";
import { useThreadSnapshotCache } from "./thread-snapshot-query";
import { useProjectThreads } from "./useProjectThreads";

export function useDisplayedThread(projectId: string, threadId: string | null): Thread | null {
  const { threads } = useProjectThreads(projectId);
  const snapshotThread = useThreadSnapshotCache(threadId)?.data?.thread;
  if (!threadId) return null;
  return threads?.find((candidate) => candidate.id === threadId) ?? snapshotThread ?? null;
}
