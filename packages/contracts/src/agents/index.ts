/** Agent source, account/system catalog and retained conversation configuration contracts. */
import type { InvocationPatch } from "./execution-knobs.js";

export * from "./execution-knobs.js";

/** Exact immutable revision selected from an authorized account/system catalog entry. */
export interface AgentSelection {
  catalogEntryId: string;
  definitionRevisionId: string;
}
export interface AgentCatalogItem {
  selection: AgentSelection;
  slug: string;
  name: string;
  description: string;
  model: string | null;
  ownership: "system" | "personal";
  unavailableReasons: string[];
}
export interface AgentCatalogCursor {
  nameSortKey: string;
  id: string;
}
export interface AgentCatalogPage {
  agents: AgentCatalogItem[];
  nextCursor: AgentCatalogCursor | null;
}

/** Raw overlay retained for inspection/export; effective values live in `configuration`. */
export interface InvocationOverlay {
  systemPrompt?: string;
  overrides?: InvocationPatch;
}

/** Where an agent definition came from, for grouping and provenance badges. */
export type AgentSource = "builtin" | "package" | "user";

/** Identity vocabulary for the agent-less generic subagent (a binding with no Agent revision). */
export const GENERIC_SUBAGENT_SLUG = "subagent";
export const GENERIC_SUBAGENT_NAME = "Subagent";
/** Host-owned empty default body, matching the seeded General agent's empty body. */
export const GENERIC_AGENT_BODY = "";

export type {
  AgentDefinitionDetail,
  AgentDefinitionResponse,
  AgentSkillLinkDetail,
  DefinitionMeta,
  DefinitionRevisionListResponse,
  DefinitionRevisionSummary,
  PatchAgentSkillLinkRequest,
  SkillDefinitionDetail,
  SkillDefinitionResponse,
  SkillFilePayload,
  UpdateAgentDefinitionRequest,
  UpdateSkillDefinitionRequest,
} from "./definitions.js";

export * from "./install.js";
