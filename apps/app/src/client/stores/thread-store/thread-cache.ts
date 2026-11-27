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
import { afterCurrentDispatch } from "@/lib/after-current-dispatch";

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
      afterCurrentDispatch(() => {
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
      afterCurrentDispatch(() => {
        if (accountSignal?.aborted) return;
        void client.invalidateQueries(
          { queryKey: threadQueryKeys.snapshot(threadId), exact: true },
          { cancelRefetch: false },
        );
      });
    },
  };
}
