/** Exact Agent selection plus the display snapshot reserved before creation. */
import type { AgentCatalogItem } from "@meridian/contracts/agents";
import type { AiWriteMode } from "@meridian/contracts/works";

export type CreationAgent = Pick<AgentCatalogItem, "selection" | "slug" | "name">;
export type CreationChoices = {
  workId?: string;
  agent?: CreationAgent;
  /** Only a mode the writer picked in this composer; otherwise the Work's default rules. */
  aiWriteMode?: AiWriteMode;
};

/** The Agent a started chat is bound to: its revision when known, else only its name. */
export type BoundAgent = { name: string | null; definitionRevisionId: string | null };

/** The bound Agent's catalog row: its own revision, else its Agent by name. */
export function boundAgentRow(
  agents: readonly AgentCatalogItem[],
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
