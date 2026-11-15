/** Exact Agent selection plus the display snapshot reserved before creation. */
import type { AgentCatalogItem, AgentSelection } from "@meridian/contracts/agents";
import type { AiWriteMode } from "@meridian/contracts/works";

/** A catalog row the writer can pick: available, with a revision to bind. */
export type PickableAgent = AgentCatalogItem & { selection: AgentSelection };
export type CreationAgent = Pick<PickableAgent, "selection" | "slug" | "name">;
export type CreationChoices = {
  workId?: string;
  agent?: CreationAgent;
  /** The model the new chat runs its Agent on, when not the Agent's own. */
  model?: string | null;
  /** Only a mode the writer picked in this composer; otherwise the Work's default rules. */
  aiWriteMode?: AiWriteMode;
};

export function pickableAgents(agents: readonly AgentCatalogItem[]): PickableAgent[] {
  return agents.filter(
    (agent): agent is PickableAgent =>
      agent.selection !== null && agent.unavailableReasons.length === 0,
  );
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
  return row ? { selection: row.selection, slug: row.slug, name: row.name } : null;
}
