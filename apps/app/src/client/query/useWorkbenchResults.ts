// @ts-nocheck
/**
 * useWorkbenchResults — list promoted artifacts ("Results") for a workbench.
 *
 * Backed by `GET /api/workbenches/:workbenchId/results`. Returns a
 * {@link ListQueryStatus} so the Results rail drives UI honestly off
 * `status` (loading/empty/ready/error/disabled) instead of inferring from
 * `array.length`.
 *
 * Disabled when `workbenchId` is null (e.g. before the workbench route
 * resolves). The query keys are owned by `workbenchQueryKeys.results(...)` —
 * keep invalidations there if a future write-path (manual demote, retry
 * promotion) lands.
 */
import { useQuery } from "@tanstack/react-query";

import { listWorkbenchResults, type WorkbenchResultItem } from "@/client/api/workbench-results-api";

import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { workbenchQueryKeys } from "./workbench-query-keys";

export type WorkbenchResultsStatus = ListQueryStatus<WorkbenchResultItem> & {
  results: WorkbenchResultItem[] | null;
};

export function useWorkbenchResults(
  workbenchId: string | null,
  options?: { enabled?: boolean },
): WorkbenchResultsStatus {
  const callerEnabled = options?.enabled ?? true;
  const enabled = callerEnabled && Boolean(workbenchId);

  const result = unwrapListQuery(
    useQuery({
      queryKey: workbenchQueryKeys.results(workbenchId ?? ""),
      queryFn: () => listWorkbenchResults(workbenchId as string),
      // Promoted artifacts are append-mostly; a short stale window keeps
      // the rail fresh after a turn lands without hammering the server on
      // every focus event.
      staleTime: 15_000,
      enabled,
    }),
  );

  if (!enabled) {
    return {
      ...result,
      data: null,
      status: "disabled",
      results: null,
    };
  }
  return { ...result, results: result.data };
}
