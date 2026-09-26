/**
 * Preference domain helpers: copy and merge the locked ProjectPreferences contract without sharing mutable default arrays.
 * Key decision: merge semantics live outside adapters so in-memory and Drizzle implementations stay behaviorally identical.
 */
import {
  DEFAULT_PROJECT_PREFERENCES,
  type ProjectPreferences,
  type UpdateProjectPreferencesRequest,
} from "@meridian/contracts/preferences";

export function defaultProjectPreferences(): ProjectPreferences {
  return {
    threadGroupBy: DEFAULT_PROJECT_PREFERENCES.threadGroupBy,
    pinnedThreadIds: [...DEFAULT_PROJECT_PREFERENCES.pinnedThreadIds],
    autoResume: { ...DEFAULT_PROJECT_PREFERENCES.autoResume },
  };
}

export function copyProjectPreferences(preferences: ProjectPreferences): ProjectPreferences {
  return {
    threadGroupBy: preferences.threadGroupBy,
    pinnedThreadIds: [...preferences.pinnedThreadIds],
    autoResume: { ...preferences.autoResume },
  };
}

export function mergeProjectPreferences(
  current: ProjectPreferences | null | undefined,
  patch: UpdateProjectPreferencesRequest,
): ProjectPreferences {
  const base = current ? copyProjectPreferences(current) : defaultProjectPreferences();
  return {
    threadGroupBy: patch.threadGroupBy ?? base.threadGroupBy,
    pinnedThreadIds:
      patch.pinnedThreadIds !== undefined ? [...patch.pinnedThreadIds] : base.pinnedThreadIds,
    autoResume: patch.autoResume ? { ...patch.autoResume } : { ...base.autoResume },
  };
}
