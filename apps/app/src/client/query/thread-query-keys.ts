/**
 * thread-query-keys — the canonical React Query key factory for thread-scoped
 * data (snapshot, uploads rail, recent-documents rail, live lineage).
 * Single source of key shapes for thread reads/invalidations.
 *
 * All thread-scoped keys share a `["threads", threadId, ...]` prefix derived
 * from `thread(threadId)` so `queryClient.invalidateQueries({ queryKey:
 * threadQueryKeys.thread(id) })` cleanly invalidates every cache rooted at
 * that thread.
 */
export const threadQueryKeys = {
  all: ["threads"] as const,
  thread: (threadId: string) => ["threads", threadId] as const,
  snapshot: (threadId: string) => ["threads", threadId, "snapshot"] as const,
  uploads: (threadId: string) => ["threads", threadId, "uploads"] as const,
  recentDocuments: (threadId: string, limit?: number) =>
    ["threads", threadId, "recent-documents", limit ?? null] as const,
  liveLineageRoot: (threadId: string) => ["threads", threadId, "live-lineage"] as const,
  liveLineage: (threadId: string, turnId: string) =>
    ["threads", threadId, "live-lineage", turnId] as const,
};
