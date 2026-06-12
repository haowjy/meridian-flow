// @ts-nocheck

import type { Work } from "@meridian/contracts/protocol";
import { useQuery } from "@tanstack/react-query";

import { listWorkbenchWorks } from "@/client/api/workbenches-api";
import { useIsWorkbenchPendingCreation } from "@/client/stores";

import { unwrapListQuery } from "./list-query";
import { workbenchQueryKeys } from "./workbench-query-keys";

/**
 * Work items belonging to a single workbench. `null` = not loaded yet,
 * `[]` = loaded empty.
 *
 * The query is suppressed while the workbench is still pending optimistic
 * creation on the server; otherwise the request races `POST /api/workbenches`
 * and 404s during a normal flow.
 */
export function useWorks(
  workbenchId: string,
  options?: { enabled?: boolean },
): {
  works: Work[] | null;
  isError: boolean;
  isFetching: boolean;
  refetch: () => void;
} {
  const callerEnabled = options?.enabled ?? true;
  const isPendingCreation = useIsWorkbenchPendingCreation(workbenchId);
  const enabled = callerEnabled && !isPendingCreation;
  const { data, isError, isFetching, refetch } = unwrapListQuery(
    useQuery({
      queryKey: workbenchQueryKeys.works(workbenchId),
      queryFn: () => listWorkbenchWorks(workbenchId),
      staleTime: 30_000,
      enabled,
    }),
  );

  return { works: data, isError, isFetching, refetch };
}
