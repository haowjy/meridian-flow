/**
 * ThreadCachePort — the thin seam between the thread store's lifecycle
 * transitions and the React Query cache.
 *
 * The thread store owns per-thread turn state; the persisted thread-list and
 * snapshot projections live in React Query. The store depends on this port
 * (an interface), never on `QueryClient` directly, so the two ownerships stay
 * decoupled — that dual ownership behind a raw `queryClient` construction dep
 * was the structural root of the recurring `useThreadStore`/`QueryClient`
 * fragility.
 */

import type { Thread, ThreadListItem } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import { projectQueryKeys } from "@/client/query/project-query-keys";
import {
  patchThreadInProjectCaches,
  type ThreadListLifecycle,
  upsertThreadInProject,
} from "@/client/query/project-thread-cache";
import { threadQueryKeys } from "@/client/query/thread-query-keys";

export interface ThreadCachePort {
  /** Optimistically insert/merge a thread into its project's cached list. */
  upsertThread(thread: Thread, lifecycle?: ThreadListLifecycle): void;
  /** Patch a thread row in place across every cached project thread list. */
  patchThread(threadId: string, patch: Partial<ThreadListItem>): void;
  /**
   * Invalidate the persisted projections for a terminal turn: the thread
   * snapshot, active draft-review cards, and, when the owning project is
   * known, its thread list.
   */
  invalidateThread(threadId: string, projectId: string | null): void;
}

export function createThreadCache(client: QueryClient): ThreadCachePort {
  return {
    upsertThread(thread, lifecycle) {
      upsertThreadInProject(client, thread, lifecycle);
    },
    patchThread(threadId, patch) {
      patchThreadInProjectCaches(client, threadId, patch);
    },
    invalidateThread(threadId, projectId) {
      // Deferred to a microtask: terminal-turn invalidation runs inside the
      // live event reducer, so firing `invalidateQueries` synchronously could
      // schedule a refetch + React update during a render/notification phase.
      // The store writes its turn state synchronously first; the cache catches
      // projector-only fields (final usage/cost metadata) on the next tick.
      queueMicrotask(() => {
        void client.invalidateQueries({ queryKey: threadQueryKeys.snapshot(threadId) });
        void client.invalidateQueries({ queryKey: threadQueryKeys.drafts(threadId) });
        if (projectId) {
          void client.invalidateQueries({ queryKey: projectQueryKeys.threads(projectId) });
        }
      });
    },
  };
}
