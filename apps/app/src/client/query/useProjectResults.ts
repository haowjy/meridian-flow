/**
 * useProjectResults — list promoted artifacts ("Results") for a project.
 *
 * Backed by `GET /api/projects/:projectId/results`. Returns a
 * {@link ListQueryStatus} so the Results rail drives UI honestly off
 * `status` (loading/empty/ready/error/disabled) instead of inferring from
 * `array.length`.
 *
 * Disabled when `projectId` is null (e.g. before the project route
 * resolves). The query keys are owned by `projectQueryKeys.results(...)` —
 * keep invalidations there if a future write-path (manual demote, retry
 * promotion) lands.
 */
import { useQuery } from "@tanstack/react-query";

import { listProjectResults, type ProjectResultItem } from "@/client/api/project-results-api";

import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";

export type ProjectResultsStatus = ListQueryStatus<ProjectResultItem> & {
  results: ProjectResultItem[] | null;
};

export function useProjectResults(
  projectId: string | null,
  options?: { enabled?: boolean },
): ProjectResultsStatus {
  const callerEnabled = options?.enabled ?? true;
  const enabled = callerEnabled && Boolean(projectId);

  const result = unwrapListQuery(
    useQuery({
      queryKey: projectQueryKeys.results(projectId ?? ""),
      queryFn: () => listProjectResults(projectId as string),
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
