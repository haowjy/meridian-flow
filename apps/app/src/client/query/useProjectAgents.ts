// @ts-nocheck
/**
 * useProjectAgents — selectable agent catalog for a project.
 *
 * Backed by `GET /api/projects/:projectId/agents`. Returns a
 * {@link ListQueryStatus} so picker UI drives honestly off `status` instead of
 * inferring from `agents.length`. Disabled when `projectId` is null (Home
 * hero before a project exists).
 */

import type { ProjectAgentSummary } from "@meridian/contracts/agents";
import { useQuery } from "@tanstack/react-query";

import { listProjectAgents } from "@/client/api/project-agents-api";

import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { projectQueryKeys } from "./project-query-keys";

export type ProjectAgentsStatus = ListQueryStatus<ProjectAgentSummary> & {
  agents: ProjectAgentSummary[] | null;
};

export function useProjectAgents(
  projectId: string | null,
  options?: { enabled?: boolean },
): ProjectAgentsStatus {
  const callerEnabled = options?.enabled ?? true;
  const enabled = callerEnabled && Boolean(projectId);

  const result = unwrapListQuery(
    useQuery({
      queryKey: projectQueryKeys.agents(projectId ?? ""),
      queryFn: async () => {
        const response = await listProjectAgents(projectId as string);
        return response.agents;
      },
      staleTime: 60_000,
      enabled,
    }),
  );

  if (!enabled) {
    return {
      ...result,
      data: null,
      status: "disabled",
      agents: null,
    };
  }
  return { ...result, agents: result.data };
}
