/**
 * Agent and skill definition editing contracts. Full catalog summaries live in
 * `./index.ts`; these shapes cover writes and append-only revision history.
 *
 * Key decisions:
 * - JSON-natural: string IDs, ISO date strings, union literals.
 * - `meta` / `config` are open objects so unknown YAML frontmatter keys round-trip.
 * - Every save appends an immutable revision; restore always creates a new revision.
 */
import type { AgentSource } from "./index.js";

/** Open YAML-frontmatter object; unknown keys pass through on save. */
export type DefinitionMeta = Record<string, unknown>;

/** Operational link override — not versioned definition content. */
export interface PatchAgentSkillLinkRequest {
  modelInvocable: boolean;
}

/** Per-agent skill wiring submitted with an agent save. */
export interface AgentSkillLinkInput {
  skillSlug: string;
  ordinal: number;
  modelInvocable?: boolean;
  userInvocable?: boolean;
}

/** Resolved skill link returned with an agent definition detail. */
export interface AgentSkillLinkDetail {
  skillSlug: string;
  ordinal: number;
  modelInvocable: boolean | null;
  userInvocable: boolean | null;
}

/** PUT body for agent definition save. */
export interface UpdateAgentDefinitionRequest {
  body: string;
  meta: DefinitionMeta;
  config?: DefinitionMeta;
  skillLinks?: AgentSkillLinkInput[];
}

/** PUT body for skill definition save. */
export interface UpdateSkillDefinitionRequest {
  body: string;
  meta: DefinitionMeta;
}

/** Immutable revision row summary for history lists. */
export interface DefinitionRevisionSummary {
  id: string;
  contentChecksum: string;
  createdAt: string;
}

/** Full agent definition returned after a write or restore. */
export interface AgentDefinitionDetail {
  slug: string;
  body: string;
  meta: DefinitionMeta;
  config: DefinitionMeta;
  source: AgentSource;
  packageName: string | null;
  originalContentChecksum: string | null;
  contentChecksum: string;
  isEdited: boolean;
  skillLinks: AgentSkillLinkDetail[];
}

/** Bundled skill file payload — UTF-8 string or base64-armed binary. */
export type SkillFilePayload =
  | string
  | {
      encoding: "base64";
      data: string;
    };

/** Full skill definition returned after a write or restore. */
export interface SkillDefinitionDetail {
  slug: string;
  body: string;
  meta: DefinitionMeta;
  files: Record<string, SkillFilePayload>;
  source: AgentSource;
  packageName: string | null;
  originalContentChecksum: string | null;
  contentChecksum: string;
  isEdited: boolean;
}

export interface AgentDefinitionResponse {
  agent: AgentDefinitionDetail;
  revisionId: string;
}

export interface SkillDefinitionResponse {
  skill: SkillDefinitionDetail;
  revisionId: string;
}

export interface DefinitionRevisionListResponse {
  revisions: DefinitionRevisionSummary[];
}
