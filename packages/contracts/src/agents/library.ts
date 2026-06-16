/**
 * Library screen contract — the project's full capability inventory.
 *
 * Distinct from the catalog (`ProjectAgentsResponse`): the catalog lists only
 * agents *selectable for new threads* (enabled + primary); the Library lists
 * everything the project owns — including disabled agents and skills not
 * linked to any agent — because the Library is the canonical authoring surface
 * and an unlisted definition would be unreachable in the UI.
 *
 * Key decisions:
 * - `isEdited` is computed server-side (content checksum vs
 *   `originalContentChecksum`) so the client never re-implements pristine
 *   semantics; user-authored definitions (no pristine to diverge from) are
 *   always `false`.
 * - Summaries only — full definition detail (body, meta, files, revisions)
 *   stays behind the definition routes in `definitions.ts`.
 */

import type { AgentSource } from "./index.js";

/** One agent definition in the Library list (selectable or not). */
export interface LibraryAgentSummary {
  slug: string;
  name: string;
  description: string;
  source: AgentSource;
  /** Human package name when source === "package", else null. */
  packageName: string | null;
  /** Disabled agents stay listed — the Library is inventory, not the picker. */
  enabled: boolean;
  /** Local content diverges from the installed pristine copy. */
  isEdited: boolean;
}

/** One skill definition in the Library list. */
export interface LibrarySkillSummary {
  slug: string;
  /** The model-facing decision interface — slug + description is the whole catalog line. */
  description: string;
  source: AgentSource;
  packageName: string | null;
  isEdited: boolean;
}

/** One installed package with its content counts. */
export interface LibraryPackageSummary {
  slug: string;
  /** Package install row id — routes update/export by install id, not package name. */
  installId: string;
  name: string;
  /** Installed version label, null when the source carries none. */
  version: string | null;
  agentCount: number;
  skillCount: number;
}

/** Response shape for `GET /api/projects/:projectId/library`. */
export interface ProjectLibraryResponse {
  agents: LibraryAgentSummary[];
  skills: LibrarySkillSummary[];
  packages: LibraryPackageSummary[];
}
