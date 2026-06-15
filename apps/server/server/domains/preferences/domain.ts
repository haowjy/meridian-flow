/**
 * Preference domain helpers: copy and merge the locked ProjectPreferences contract without sharing mutable default arrays.
 * Key decision: merge semantics live outside adapters so in-memory and Drizzle implementations stay behaviorally identical.
 */
import {
  DEFAULT_PROJECT_PREFERENCES,
  type ProjectPreferences,
  type UpdateProjectPreferencesRequest,
} from "@meridian/contracts/preferences";

const DEFAULT_AUTO_RESUME = {
  enabled: DEFAULT_PROJECT_PREFERENCES.autoResume?.enabled ?? true,
  timeoutMs: DEFAULT_PROJECT_PREFERENCES.autoResume?.timeoutMs ?? 270_000,
};

export function defaultProjectPreferences(): ProjectPreferences {
  return {
    threadGroupBy: DEFAULT_PROJECT_PREFERENCES.threadGroupBy,
    pinnedThreadIds: [...DEFAULT_PROJECT_PREFERENCES.pinnedThreadIds],
    defaultAgentSlug: DEFAULT_PROJECT_PREFERENCES.defaultAgentSlug,
    autoResume: { ...DEFAULT_AUTO_RESUME },
  };
}

export function copyProjectPreferences(preferences: ProjectPreferences): ProjectPreferences {
  return {
    threadGroupBy: preferences.threadGroupBy,
    pinnedThreadIds: [...preferences.pinnedThreadIds],
    defaultAgentSlug: preferences.defaultAgentSlug,
    autoResume: preferences.autoResume ? { ...preferences.autoResume } : undefined,
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
    defaultAgentSlug:
      patch.defaultAgentSlug !== undefined ? patch.defaultAgentSlug : base.defaultAgentSlug,
    autoResume:
      patch.autoResume !== undefined
        ? { ...patch.autoResume }
        : base.autoResume
          ? { ...base.autoResume }
          : undefined,
  };
}
