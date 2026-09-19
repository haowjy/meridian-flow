/** Agent source, account/system catalog and retained conversation configuration contracts. */

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

/** Exact skill content and supporting files retained for later loading. */
export interface RetainedSkillReference {
  packageRevisionId: string;
  path: string;
  contentDigest: string;
}

/** Canonical reasoning-effort names carried from Mars metadata into resolved configuration. */
export type AgentEffort = "low" | "medium" | "high" | "xhigh" | "none" | "disabled" | "adaptive";

/** Resolved once at binding; authored source remains presence-sensitive. */
export interface ResolvedAgentConfiguration {
  model: string;
  skills: { load: RetainedSkillReference[]; available: RetainedSkillReference[] };
  namedTargets: Array<{ name: string; definitionRevisionId: string }>;
  tools?: string[] | Record<string, "allow" | "deny">;
  "disallowed-tools"?: string[];
  effort?: AgentEffort;
}

/** Presence-sensitive per-invocation patch. Omitted inherits; empty list clears; tool map patches one entry. */
export interface InvocationPatch {
  model?: string;
  effort?: AgentEffort;
  tools?: string[] | Record<string, "allow" | "deny">;
  "disallowed-tools"?: string[];
  subagents?: string[];
  skills?: { load?: string[]; available?: string[] };
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
