import type { AgentCatalogItem } from "@meridian/contracts/agents";
import { agentCatalogSchema } from "@meridian/contracts/agents";
import { getJson } from "./http-client";

export async function listAgentCatalog(
  signal: AbortSignal,
  projectId?: string,
): Promise<AgentCatalogItem[]> {
  const query = projectId ? `?${new URLSearchParams({ projectId })}` : "";
  const catalog = await getJson(`/api/agents${query}`, { signal, schema: agentCatalogSchema });
  return catalog.agents;
}
