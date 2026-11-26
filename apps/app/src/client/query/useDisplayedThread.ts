import type { Thread } from "@meridian/contracts/protocol";
import { useThreadSnapshotCache } from "./thread-snapshot-query";
import { useProjectThreads } from "./useProjectThreads";

export function useDisplayedThread(projectId: string, threadId: string | null): Thread | null {
  const { threads } = useProjectThreads(projectId);
  const snapshotThread = useThreadSnapshotCache(threadId)?.data?.thread;
  if (!threadId) return null;
  return threads?.find((candidate) => candidate.id === threadId) ?? snapshotThread ?? null;
}
