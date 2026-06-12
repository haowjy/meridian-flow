// @ts-nocheck
/**
 * useWorkbenchAgents — selectable agent catalog for a workbench.
 *
 * Backed by `GET /api/workbenches/:workbenchId/agents`. Returns a
 * {@link ListQueryStatus} so picker UI drives honestly off `status` instead of
 * inferring from `agents.length`. Disabled when `workbenchId` is null (Home
 * hero before a workbench exists).
 */

import type { WorkbenchAgentSummary } from "@meridian/contracts/agents";
import { useQuery } from "@tanstack/react-query";

import { listWorkbenchAgents } from "@/client/api/workbench-agents-api";

import { type ListQueryStatus, unwrapListQuery } from "./list-query";
import { workbenchQueryKeys } from "./workbench-query-keys";

export type WorkbenchAgentsStatus = ListQueryStatus<WorkbenchAgentSummary> & {
  agents: WorkbenchAgentSummary[] | null;
};

export function useWorkbenchAgents(
  workbenchId: string | null,
  options?: { enabled?: boolean },
): WorkbenchAgentsStatus {
  const callerEnabled = options?.enabled ?? true;
  const enabled = callerEnabled && Boolean(workbenchId);

  const result = unwrapListQuery(
    useQuery({
      queryKey: workbenchQueryKeys.agents(workbenchId ?? ""),
      queryFn: async () => {
        const response = await listWorkbenchAgents(workbenchId as string);
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
