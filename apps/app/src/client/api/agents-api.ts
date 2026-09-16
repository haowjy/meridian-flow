/** Account/system Agent catalog; exact selections remain stable after a catalog update. */
import type {
  AgentCatalogCursor,
  AgentCatalogItem,
  AgentCatalogPage,
  AgentSelection,
} from "@meridian/contracts/agents";
import { getJson, postJson } from "./http-client";

export async function listAgents(
  after?: AgentCatalogCursor,
  signal?: AbortSignal,
  projectId?: string,
): Promise<AgentCatalogPage> {
  const query = new URLSearchParams({ limit: "100" });
  if (projectId) query.set("projectId", projectId);
  if (after) {
    query.set("afterId", after.id);
    query.set("afterNameSortKey", after.nameSortKey);
  }
  return getJson<AgentCatalogPage>(`/api/agents?${query}`, { signal });
}

/** Acquire the complete visible catalog before treating a missing choice as unavailable. */
export async function listAgentCatalog(
  signal: AbortSignal,
  projectId?: string,
): Promise<AgentCatalogItem[]> {
  const agents: AgentCatalogItem[] = [];
  let after: AgentCatalogCursor | undefined;
  do {
    signal.throwIfAborted();
    const page = await listAgents(after, signal, projectId);
    signal.throwIfAborted();
    agents.push(...page.agents);
    after = page.nextCursor ?? undefined;
  } while (after);
  return agents;
}

export function removeProjectAgent(
  projectId: string,
  selection: AgentSelection,
  signal: AbortSignal,
) {
  return postJson<{ removed: true }>(`/api/projects/${projectId}/agents/remove`, selection, {
    signal,
  });
}
