/** Account/system Agent choices with Project-scoped availability and cache ownership. */
import type { AgentCatalogItem, AgentSelection } from "@meridian/contracts/agents";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { listAgentCatalog, removeProjectAgent } from "@/client/api/agents-api";
import {
  useAccountEpochSignal,
  useAccountId,
} from "@/features/project/context/account-feature-context";
import { type ListQueryStatus, unwrapListQuery } from "./list-query";

export const agentCatalogQueryKey = (accountId: string, projectId?: string) =>
  ["agent-catalog", accountId, projectId ?? null] as const;
export type AgentCatalogStatus = ListQueryStatus<AgentCatalogItem> & {
  agents: AgentCatalogItem[] | null;
};

export function agentCatalogQueryOptions(
  accountId: string,
  accountSignal: AbortSignal,
  projectId?: string,
) {
  return queryOptions({
    queryKey: agentCatalogQueryKey(accountId, projectId),
    queryFn: ({ signal }) => listAgentCatalog(AbortSignal.any([accountSignal, signal]), projectId),
    staleTime: 60_000,
  });
}

export function useAgentCatalog(enabled = true, projectId?: string): AgentCatalogStatus {
  const accountId = useAccountId();
  const accountSignal = useAccountEpochSignal();
  const result = unwrapListQuery(
    useQuery({
      ...agentCatalogQueryOptions(accountId, accountSignal, projectId),
      enabled,
    }),
  );
  return { ...result, agents: result.data };
}

/** Removal changes only prospective choices in the authorized Project. */
export function useRemoveProjectAgent(projectId: string) {
  const accountId = useAccountId();
  const signal = useAccountEpochSignal();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (selection: AgentSelection) => removeProjectAgent(projectId, selection, signal),
    onSuccess: async (_result, selection) => {
      signal.throwIfAborted();
      const queryKey = agentCatalogQueryKey(accountId, projectId);
      await client.cancelQueries({ queryKey });
      signal.throwIfAborted();
      client.setQueryData<AgentCatalogItem[]>(queryKey, (agents) =>
        agents?.filter((agent) => agent.selection.catalogEntryId !== selection.catalogEntryId),
      );
      await client.invalidateQueries({ queryKey });
    },
  });
}
