/**
 * Agent catalog contract — the project-scoped list of selectable agents.
 *
 * Serves the composer agent picker and thread-header provenance chip. This is
 * deliberately a *summary* shape:
 * full definition records (body, meta, skill links, revisions) stay behind
 * the packages-domain API and are never needed to render a chip or picker row.
 *
 * Key decisions:
 * - JSON-natural per the contracts package rule (string IDs, union literals).
 * - Only agents that are selectable for new threads appear here — the server
 *   filters to `enabled: true` + `mode: "primary"` before responding, so the
 *   client never re-implements eligibility rules.
 * - `source` drives picker grouping ("Installed" vs "Built-in") and the chip's
 *   source badge; `packageName` carries the human badge label and is null for
 *   builtin/user agents.
 */

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
