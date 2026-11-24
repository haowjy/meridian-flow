import type { AgentCatalogItem, AgentSelection } from "@meridian/contracts/agents";
import type { ThreadOverrides } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";

export type PickableAgent = AgentCatalogItem & { selection: AgentSelection };
export type CreationAgent = Pick<PickableAgent, "selection" | "slug" | "name">;
export type CreationChoices = {
  workId?: string;
  agent?: CreationAgent;
  overrides?: ThreadOverrides;
  aiWriteMode?: AiWriteMode;
};

export function isPickable(agent: AgentCatalogItem): agent is PickableAgent {
  return agent.selection !== null && agent.unavailableReasons.length === 0;
}

export function pickableAgents(agents: readonly AgentCatalogItem[]): PickableAgent[] {
  return agents.filter(isPickable);
}

export type BoundAgent = { name: string | null; definitionRevisionId: string | null };

export function boundAgentRow(
  agents: readonly PickableAgent[],
  bound: BoundAgent,
): CreationAgent | null {
  const row =
    agents.find(
      (agent) =>
        bound.definitionRevisionId !== null &&
        agent.selection.definitionRevisionId === bound.definitionRevisionId,
    ) ?? agents.find((agent) => bound.name !== null && agent.name === bound.name);
  return row ? creationAgentOf(row) : null;
}

export function creationAgentOf(agent: PickableAgent): CreationAgent {
  return { selection: agent.selection, slug: agent.slug, name: agent.name };
}
