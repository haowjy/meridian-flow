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

import type { Thread } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import {
  projectThreadLifecycleInProjectCaches,
  type ThreadListLifecycle,
  upsertThreadInProject,
} from "@/client/query/project-thread-cache";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import { invalidateThreadProjectionDependencies } from "@/client/query/thread-work-binding-cache";

export interface ThreadCachePort {
  /** Optimistically insert/merge a thread into its project's cached list. */
  upsertThread(thread: Thread, lifecycle?: ThreadListLifecycle): void;
  /** Project live lifecycle state across project lists, Home, and Work feeds. */
  patchThread(threadId: string, lifecycle: ThreadListLifecycle): void;
  /**
   * Invalidate the persisted projections for a terminal turn: the thread
   * snapshot and, when the owning project is known, Work draft-review lists,
   * its thread list, canonical Work catalog, and the project's context trees.
   */
  invalidateThread(threadId: string, projectId: string | null): void;
}

export function createThreadCache(client: QueryClient): ThreadCachePort {
  return {
    upsertThread(thread, lifecycle) {
      upsertThreadInProject(client, thread, lifecycle);
      if (lifecycle) {
        projectThreadLifecycleInProjectCaches(client, thread.id, lifecycle);
      }
    },
    patchThread(threadId, lifecycle) {
      projectThreadLifecycleInProjectCaches(client, threadId, lifecycle);
    },
    invalidateThread(threadId, projectId) {
      // Deferred to a microtask: terminal-turn invalidation runs inside the
      // live event reducer, so firing `invalidateQueries` synchronously could
      // schedule a refetch + React update during a render/notification phase.
      // The store writes its turn state synchronously first; the cache catches
      // projector-only fields (final usage/cost metadata) on the next tick.
      queueMicrotask(() => {
        if (projectId) {
          invalidateThreadProjectionDependencies(client, {
            threadId,
            projectId,
            refreshLists: true,
            workIds: "all",
            contextTrees: "all",
          });
        } else {
          void client.invalidateQueries({ queryKey: threadQueryKeys.thread(threadId) });
        }
      });
    },
  };
}
