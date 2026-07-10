import type { ThreadListItem } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { listProjectThreads } from "@/client/api/projects-api";
import { useIsProjectPendingCreation } from "@/client/stores";

import { unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";

/**
 * Threads belonging to a single project. Seeded by the project route loader
 * (or by the optimistic-create flow). `null` = not loaded yet, `[]` = loaded empty.
 *
 * Returns `ThreadListItem[]` — the projection adds denormalized `work`,
 * `runningTurnId` and `attention` fields that the workspace UI
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
  const { data, isError, isFetching, refetch } = unwrapListQuery(
    useQuery({
      queryKey: projectQueryKeys.threads(projectId),
      queryFn: () => listProjectThreads(projectId),
      staleTime: 30_000,
      enabled,
    }),
  );

  return { threads: data, isError, isFetching, refetch };
}
