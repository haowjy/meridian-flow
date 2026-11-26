import type { Thread } from "@meridian/contracts/protocol";
import type { QueryClient } from "@tanstack/react-query";

import {
  projectThreadLifecycleInProjectCaches,
  type ThreadListLifecycle,
  upsertThreadInProject,
} from "@/client/query/project-thread-cache";
import { threadQueryKeys } from "@/client/query/thread-query-keys";
import {
  invalidateThreadKeys,
  invalidateThreadProjectionDependencies,
} from "@/client/query/thread-work-binding-cache";

export interface ThreadCachePort {
  upsertThread(thread: Thread, lifecycle?: ThreadListLifecycle): void;
  patchThread(threadId: string, lifecycle: ThreadListLifecycle): void;
  invalidateThread(
    threadId: string,
    projectId: string | null,
    options?: { snapshot?: boolean },
  ): void;
  invalidateThreadSnapshot(threadId: string): void;
}

export function createThreadCache(
  client: QueryClient,
  accountSignal?: AbortSignal,
): ThreadCachePort {
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
    invalidateThread(threadId, projectId, options) {
      const skipSnapshot = options?.snapshot === false;
      // Deferred to a microtask: terminal-turn invalidation runs inside the
      // live event reducer, so firing `invalidateQueries` synchronously could
      // schedule a refetch + React update during a render/notification phase.
      // The store writes its turn state synchronously first; the cache catches
      // projector-only fields (final usage/cost metadata) on the next tick.
      queueMicrotask(() => {
        if (accountSignal?.aborted) return;
        if (projectId) {
          invalidateThreadProjectionDependencies(client, {
            threadId,
            projectId,
            refreshLists: true,
            skipSnapshot,
          });
        } else {
          void invalidateThreadKeys(client, threadId, skipSnapshot);
        }
      });
    },
    invalidateThreadSnapshot(threadId) {
      queueMicrotask(() => {
        if (accountSignal?.aborted) return;
        void client.invalidateQueries(
          { queryKey: threadQueryKeys.snapshot(threadId), exact: true },
          { cancelRefetch: false },
        );
      });
    },
  };
}
