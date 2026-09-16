/** Exact Agent selection plus the display snapshot reserved before creation. */
import type { AgentCatalogItem } from "@meridian/contracts/agents";

export type CreationAgent = Pick<AgentCatalogItem, "selection" | "slug" | "name">;
export type CreationChoices = { workId?: string | null; agent?: CreationAgent };
