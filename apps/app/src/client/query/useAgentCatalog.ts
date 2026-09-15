/** Account/system Agent choices, available before a project is created. */
import type { AgentCatalogItem } from "@meridian/contracts/agents";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { listAgentCatalog } from "@/client/api/agents-api";
import { useFirstSendContinuity } from "@/client/first-send-continuity";
import { useAccountEpochSignal } from "@/features/project/context/account-feature-context";
import { type ListQueryStatus, unwrapListQuery } from "./list-query";

export const agentCatalogQueryKey = (accountId: string) => ["agent-catalog", accountId] as const;
export type AgentCatalogStatus = ListQueryStatus<AgentCatalogItem> & {
  agents: AgentCatalogItem[] | null;
};

export function agentCatalogQueryOptions(accountId: string, accountSignal: AbortSignal) {
  return queryOptions({
    queryKey: agentCatalogQueryKey(accountId),
    queryFn: ({ signal }) => listAgentCatalog(AbortSignal.any([accountSignal, signal])),
    staleTime: 60_000,
  });
}

export function useAgentCatalog(enabled = true): AgentCatalogStatus {
  const { accountId } = useFirstSendContinuity();
  const accountSignal = useAccountEpochSignal();
  const result = unwrapListQuery(
    useQuery({
      ...agentCatalogQueryOptions(accountId, accountSignal),
      enabled,
    }),
  );
  return { ...result, agents: result.data };
}
