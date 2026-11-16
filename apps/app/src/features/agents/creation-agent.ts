/** Exact Agent selection plus the display snapshot reserved before creation. */
import type { AgentCatalogItem, AgentSelection } from "@meridian/contracts/agents";
import type { ThreadOverrides } from "@meridian/contracts/threads";
import type { AiWriteMode } from "@meridian/contracts/works";

/** A catalog row the writer can pick: available, with a revision to bind. */
export type PickableAgent = AgentCatalogItem & { selection: AgentSelection };
export type CreationAgent = Pick<PickableAgent, "selection" | "slug" | "name">;
export type CreationChoices = {
  workId?: string;
  agent?: CreationAgent;
  /** The model and reasoning the new chat runs its Agent at, where not the Agent's own. */
  overrides?: ThreadOverrides;
  /** Only a mode the writer picked in this composer; otherwise the Work's default rules. */
  aiWriteMode?: AiWriteMode;
};

export function isPickable(agent: AgentCatalogItem): agent is PickableAgent {
  return agent.selection !== null && agent.unavailableReasons.length === 0;
}

export function pickableAgents(agents: readonly AgentCatalogItem[]): PickableAgent[] {
  return agents.filter(isPickable);
}

/** The Agent a started chat is bound to: its revision when known, else only its name. */
export type BoundAgent = { name: string | null; definitionRevisionId: string | null };

/** The bound Agent's catalog row: its own revision, else its Agent by name. */
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
