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
