/**
 * Purpose: (user, workbench)-scoped UI preferences shared by the app and server.
 * These are the *authenticated user's* preferences for a specific workbench's
 * thread list — persisted server-side so they follow the user across devices,
 * keyed on (userId, workbenchId). Distinct from ephemeral per-session client
 * state (filter, search) which never leaves the app.
 *
 * JSON-natural only: string-union enums and string arrays, no Date/branded types.
 */

/** How the sidebar thread list is grouped. The user's persisted per-workbench default. */
export type ThreadGroupBy = "work" | "date" | "flat";

export const THREAD_GROUP_BY_VALUES: readonly ThreadGroupBy[] = ["work", "date", "flat"];

/**
 * The calling user's preferences within one workbench. Small and bounded —
 * group-by default plus the set of pinned thread ids (which are themselves
 * workbench-scoped). The thread list is fetched separately; the client
 * cross-references `pinnedThreadIds` against it, so no projection change.
 */
export interface WorkbenchPreferences {
  threadGroupBy: ThreadGroupBy;
  /** Ids of threads in this workbench the user has pinned to the top of the list. */
  pinnedThreadIds: string[];
  /**
   * Agent slug pre-selected in the composer for new threads in this workbench.
   * Null means no explicit default (client falls back to builtin "general").
   */
  defaultAgentSlug: string | null;
  /** Same-turn checkpoint timeout policy. Defaults keep runs moving if the user walks away. */
  autoResume?: {
    enabled: boolean;
    timeoutMs: number;
  };
}

/** Server + client seed when the user has no stored preferences for a workbench. */
export const DEFAULT_WORKBENCH_PREFERENCES: WorkbenchPreferences = {
  threadGroupBy: "work",
  pinnedThreadIds: [],
  defaultAgentSlug: null,
  autoResume: {
    enabled: true,
    timeoutMs: 270_000,
  },
};

/** PUT body — partial so callers can update just group-by or just pins. */
export type UpdateWorkbenchPreferencesRequest = Partial<WorkbenchPreferences>;

/** Envelope for `GET`/`PUT /api/workbenches/:workbenchId/preferences`. */
export interface WorkbenchPreferencesResponse {
  preferences: WorkbenchPreferences;
}
