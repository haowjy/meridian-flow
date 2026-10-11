/** Copy and merge the project runtime policy without sharing mutable defaults. */
import {
  DEFAULT_PROJECT_PREFERENCES,
  type ProjectPreferences,
  type UpdateProjectPreferencesRequest,
} from "@meridian/contracts/preferences";

export function defaultProjectPreferences(): ProjectPreferences {
  return {
    autoResume: { ...DEFAULT_PROJECT_PREFERENCES.autoResume },
  };
}

export function copyProjectPreferences(preferences: ProjectPreferences): ProjectPreferences {
  return {
    autoResume: { ...preferences.autoResume },
  };
}

export function mergeProjectPreferences(
  current: ProjectPreferences | null | undefined,
  patch: UpdateProjectPreferencesRequest,
): ProjectPreferences {
  const base = current ? copyProjectPreferences(current) : defaultProjectPreferences();
  return {
    autoResume: patch.autoResume ? { ...patch.autoResume } : { ...base.autoResume },
  };
}
