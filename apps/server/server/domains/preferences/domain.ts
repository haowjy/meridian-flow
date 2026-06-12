// @ts-nocheck
/**
 * Preference domain helpers: copy and merge the locked WorkbenchPreferences contract without sharing mutable default arrays.
 * Key decision: merge semantics live outside adapters so in-memory and Drizzle implementations stay behaviorally identical.
 */
import {
  DEFAULT_WORKBENCH_PREFERENCES,
  type UpdateWorkbenchPreferencesRequest,
  type WorkbenchPreferences,
} from "@meridian/contracts/preferences";

const DEFAULT_AUTO_RESUME = {
  enabled: DEFAULT_WORKBENCH_PREFERENCES.autoResume?.enabled ?? true,
  timeoutMs: DEFAULT_WORKBENCH_PREFERENCES.autoResume?.timeoutMs ?? 270_000,
};

export function defaultWorkbenchPreferences(): WorkbenchPreferences {
  return {
    threadGroupBy: DEFAULT_WORKBENCH_PREFERENCES.threadGroupBy,
    pinnedThreadIds: [...DEFAULT_WORKBENCH_PREFERENCES.pinnedThreadIds],
    defaultAgentSlug: DEFAULT_WORKBENCH_PREFERENCES.defaultAgentSlug,
    autoResume: { ...DEFAULT_AUTO_RESUME },
  };
}

export function copyWorkbenchPreferences(preferences: WorkbenchPreferences): WorkbenchPreferences {
  return {
    threadGroupBy: preferences.threadGroupBy,
    pinnedThreadIds: [...preferences.pinnedThreadIds],
    defaultAgentSlug: preferences.defaultAgentSlug,
    autoResume: preferences.autoResume ? { ...preferences.autoResume } : undefined,
  };
}

export function mergeWorkbenchPreferences(
  current: WorkbenchPreferences | null | undefined,
  patch: UpdateWorkbenchPreferencesRequest,
): WorkbenchPreferences {
  const base = current ? copyWorkbenchPreferences(current) : defaultWorkbenchPreferences();
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
