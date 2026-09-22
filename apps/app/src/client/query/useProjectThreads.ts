import type { ThreadListItem } from "@meridian/contracts/protocol";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";

import { listProjectThreads } from "@/client/api/projects-api";
import { useIsProjectPendingCreation } from "@/client/stores";

import { unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";
import { applyThreadRenameFence, captureThreadRenameFence } from "./thread-rename-command";

/**
 * The project thread list read is fenced against in-flight thread renames: a
 * response captured before a rename revises the title is re-projected instead
 * of restoring the pre-rename row. Exposed so non-observer reads (tests,
 * imperative refetches) share the same fence.
 */
export function projectThreadsQueryOptions(client: QueryClient, projectId: string) {
  return {
    queryKey: projectQueryKeys.threads(projectId),
    queryFn: ({ signal }: { signal: AbortSignal }) => {
      const fence = captureThreadRenameFence(client, projectId);
      return listProjectThreads(projectId, { signal }).then((threads) =>
        applyThreadRenameFence(client, projectId, threads, fence),
      );
    },
    staleTime: 30_000,
  };
}

/**
 * Threads belonging to a single project. Seeded by the project route loader
 * (or by the optimistic-create flow). `null` = not loaded yet, `[]` = loaded empty.
 *
 * Returns `ThreadListItem[]` — the projection adds denormalized `work`,
 * `runningTurnId` and `actionRequired` fields that the workspace UI
 * needs to render row state honestly.
 *
 * The query is suppressed while the project is still pending optimistic
 * creation on the server; otherwise the request races `POST /api/projects` and
 * 404s during a normal flow.
 *
 * Pass `enabled: false` to skip the fetch (e.g. when the caller already has
 * the thread from a local cache).
 */
export function useProjectThreads(
  projectId: string,
  options?: { enabled?: boolean },
): {
  threads: ThreadListItem[] | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  const callerEnabled = options?.enabled ?? true;
  const isPendingCreation = useIsProjectPendingCreation(projectId);
  const enabled = callerEnabled && !isPendingCreation;
  const client = useQueryClient();
  const { data, isError, isFetching, refetch } = unwrapListQuery(
    useQuery({
      ...projectThreadsQueryOptions(client, projectId),
      enabled,
    }),
  );

  return { threads: data, isError, isFetching, refetch };
}
