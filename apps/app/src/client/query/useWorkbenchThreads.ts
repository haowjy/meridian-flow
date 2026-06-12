// @ts-nocheck

import type { ThreadListItem } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { listWorkbenchThreads } from "@/client/api/workbenches-api";
import { useIsWorkbenchPendingCreation } from "@/client/stores";

import { unwrapListQuery } from "./list-query";
import { workbenchQueryKeys } from "./workbench-query-keys";

/**
 * Threads belonging to a single workbench. Seeded by the workbench route loader
 * (or by the optimistic-create flow). `null` = not loaded yet, `[]` = loaded empty.
 *
 * Returns `ThreadListItem[]` — the projection adds denormalized `work`,
 * `runningTurnId`, and `waitingForUser` lifecycle fields that the workspace UI
 * needs to render row state honestly.
 *
 * The query is suppressed while the workbench is still pending optimistic
 * creation on the server; otherwise the request races `POST /api/workbenches` and
 * 404s during a normal flow.
 *
 * Pass `enabled: false` to skip the fetch (e.g. when the caller already has
 * the thread from a local cache).
 */
export function useWorkbenchThreads(
  workbenchId: string,
  options?: { enabled?: boolean },
): {
  threads: ThreadListItem[] | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  const callerEnabled = options?.enabled ?? true;
  const isPendingCreation = useIsWorkbenchPendingCreation(workbenchId);
  const enabled = callerEnabled && !isPendingCreation;
  const { data, isError, isFetching, refetch } = unwrapListQuery(
    useQuery({
      queryKey: workbenchQueryKeys.threads(workbenchId),
      queryFn: () => listWorkbenchThreads(workbenchId),
      staleTime: 30_000,
      enabled,
    }),
  );

  return { threads: data, isError, isFetching, refetch };
}
