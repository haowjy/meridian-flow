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
}

/** Where an agent definition came from, for grouping and provenance badges. */
export type AgentSource = "builtin" | "package" | "user";

/** One selectable agent in a project's catalog. */
export interface ProjectAgentSummary {
  /** Stable agent slug — the identity threads bind to at first send. */
  slug: string;
  /** Display name from definition meta (`meta.name`). */
  name: string;
  /** One-line description shown in picker rows. */
  description: string;
  /** Definition origin — drives picker grouping and source badges. */
  source: AgentSource;
  /**
   * Human-readable package name when `source === "package"`, else null.
   * Used as the chip/picker source badge label ("Meridian" is rendered
   * client-side for builtins).
   */
  packageName: string | null;
}

/** Response shape for `GET /api/projects/:projectId/agents`. */
export interface ProjectAgentsResponse {
  agents: ProjectAgentSummary[];
}

export type {
  AgentDefinitionDetail,
  AgentDefinitionResponse,
  AgentSkillLinkDetail,
  AgentSkillLinkInput,
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
