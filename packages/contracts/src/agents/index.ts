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

/** Resolved once at binding; authored source remains presence-sensitive. */
export interface ResolvedAgentConfiguration {
  model: string;
  skills: { load: RetainedSkillReference[]; available: RetainedSkillReference[] };
  namedTargets: Array<{ name: string; definitionRevisionId: string }>;
  tools?: string[] | Record<string, "allow" | "deny">;
  "disallowed-tools"?: string[];
  effort?: "low" | "medium" | "high" | "xhigh" | "none" | "disabled" | "adaptive";
}

/** Where an agent definition came from, for grouping and provenance badges. */
export type AgentSource = "builtin" | "package" | "user";

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
