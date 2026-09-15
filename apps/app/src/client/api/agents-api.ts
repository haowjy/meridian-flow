/** Account/system Agent catalog; exact selections remain stable after a catalog update. */
import type {
  AgentCatalogCursor,
  AgentCatalogItem,
  AgentCatalogPage,
} from "@meridian/contracts/agents";
import { getJson } from "./http-client";

export async function listAgents(
  after?: AgentCatalogCursor,
  signal?: AbortSignal,
): Promise<AgentCatalogPage> {
  const query = new URLSearchParams({ limit: "100" });
  if (after) {
    query.set("afterId", after.id);
    query.set("afterNameSortKey", after.nameSortKey);
  }
  return getJson<AgentCatalogPage>(`/api/agents?${query}`, { signal });
}

/** Acquire the complete visible catalog before treating a missing choice as unavailable. */
export async function listAgentCatalog(signal: AbortSignal): Promise<AgentCatalogItem[]> {
  const agents: AgentCatalogItem[] = [];
  let after: AgentCatalogCursor | undefined;
  do {
    signal.throwIfAborted();
    const page = await listAgents(after, signal);
    signal.throwIfAborted();
    agents.push(...page.agents);
    after = page.nextCursor ?? undefined;
  } while (after);
  return agents;
}
