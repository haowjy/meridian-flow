/** Exact Agent selection plus the display snapshot reserved before creation. */
import type { AgentCatalogItem, AgentSelection } from "@meridian/contracts/agents";
import type { AiWriteMode } from "@meridian/contracts/works";

/** A catalog row the writer can pick: available, with a revision to bind. */
export type PickableAgent = AgentCatalogItem & { selection: AgentSelection };
export type CreationAgent = Pick<PickableAgent, "selection" | "slug" | "name">;
export type CreationChoices = {
  workId?: string;
  agent?: CreationAgent;
  /** Only a mode the writer picked in this composer; otherwise the Work's default rules. */
  aiWriteMode?: AiWriteMode;
};

export function pickableAgents(agents: readonly AgentCatalogItem[]): PickableAgent[] {
  return agents.filter(
    (agent): agent is PickableAgent =>
      agent.selection !== null && agent.unavailableReasons.length === 0,
  );
}
