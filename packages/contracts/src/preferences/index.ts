/**
 * Purpose: (user, project)-scoped UI preferences shared by the app and server.
 * These are the *authenticated user's* preferences for a specific project's
 * thread list — persisted server-side so they follow the user across devices,
 * keyed on (userId, projectId). Distinct from ephemeral per-session client
 * state (filter, search) which never leaves the app.
 *
 * JSON-natural only: string-union enums and string arrays, no Date/branded types.
 */

/** How the sidebar thread list is grouped. The user's persisted per-project default. */
export type ThreadGroupBy = "work" | "date" | "flat";

export const THREAD_GROUP_BY_VALUES: readonly ThreadGroupBy[] = ["work", "date", "flat"];

/** How AI edits land in the project document. */
export type AiWriteMode = "direct" | "draft";

export const AI_WRITE_MODE_VALUES: readonly AiWriteMode[] = ["direct", "draft"];

/**
 * The calling user's preferences within one project. Small and bounded —
 * thread defaults, pinned thread ids, and project-scoped AI editing mode.
 * The thread list is fetched separately; the client
 * cross-references `pinnedThreadIds` against it, so no projection change.
 */
export interface ProjectPreferences {
  threadGroupBy: ThreadGroupBy;
  /** Ids of threads in this project the user has pinned to the top of the list. */
  pinnedThreadIds: string[];
  /**
   * Agent slug pre-selected in the composer for new threads in this project.
   * Null means no explicit default (client falls back to builtin "general").
   */
  defaultAgentSlug: string | null;
  /** Same-turn interrupt timeout policy. Defaults keep runs moving if the user walks away. */
  autoResume?: {
    enabled: boolean;
    timeoutMs: number;
  };
  /** How AI edits land: 'direct' mutates the live doc; 'draft' stages a reviewable draft the user accepts/rejects. */
  aiWriteMode?: AiWriteMode;
}

/** Server + client seed when the user has no stored preferences for a project. */
export const DEFAULT_PROJECT_PREFERENCES: ProjectPreferences = {
  threadGroupBy: "work",
  pinnedThreadIds: [],
  defaultAgentSlug: null,
  autoResume: {
    enabled: true,
    timeoutMs: 270_000,
  },
  aiWriteMode: "direct",
};

/** PUT body — partial so callers can update just group-by or just pins. */
export type UpdateProjectPreferencesRequest = Partial<ProjectPreferences>;

/** Envelope for `GET`/`PUT /api/projects/:projectId/preferences`. */
export interface ProjectPreferencesResponse {
  preferences: ProjectPreferences;
}
