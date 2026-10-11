/** Account-stamped confirmed-snapshot cache. The server remains the preference authority. */
import { ACCOUNT_LANGUAGES, ACCOUNT_THEMES } from "@meridian/contracts/preferences";
import type { AccountSettings } from "@meridian/contracts/protocol";
import { browserRecord } from "@/client/storage/browser-record";

export const ACCOUNT_SETTINGS_ACTIVE_KEY = "meridian:account-settings-active:v1";
export const ACCOUNT_SETTINGS_CACHE_PREFIX = "meridian:account-settings:v1:";
export const ACCOUNT_SETTINGS_CACHE_VERSION = 1;

type SettingsCachePayload = { settings: AccountSettings; writeId: string };

/** Self-contained so the classic pre-paint script can use exactly the runtime validator. */
export function parseSettingsCachePayload(
  value: unknown,
  languages: readonly string[],
  themes: readonly string[],
): SettingsCachePayload | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const payload = value as Record<string, unknown>;
  const settings = payload.settings;
  if (settings === null || typeof settings !== "object" || Array.isArray(settings))
    return undefined;
  const s = settings as Record<string, unknown>;
  return typeof payload.writeId === "string" &&
    typeof s.language === "string" &&
    languages.includes(s.language) &&
    typeof s.theme === "string" &&
    themes.includes(s.theme) &&
    typeof s.statsForNerds === "boolean" &&
    typeof s.workingSetSyncEnabled === "boolean"
    ? { settings: settings as AccountSettings, writeId: payload.writeId }
    : undefined;
}

function cache(accountId: string) {
  return browserRecord(
    "local",
    {
      key: ACCOUNT_SETTINGS_CACHE_PREFIX + accountId,
      version: ACCOUNT_SETTINGS_CACHE_VERSION,
      accountId,
    },
    (value) => parseSettingsCachePayload(value, ACCOUNT_LANGUAGES, ACCOUNT_THEMES),
  );
}
export function readAccountSettingsCache(accountId?: string): AccountSettings | null {
  try {
    const id = accountId ?? localStorage.getItem(ACCOUNT_SETTINGS_ACTIVE_KEY);
    return id ? (cache(id).read()?.settings ?? null) : null;
  } catch {
    return null;
  }
}
export function writeAccountSettingsCache(accountId: string, settings: AccountSettings): void {
  try {
    // Confirming an unchanged optimistic value must still wake other tabs.
    if (cache(accountId).write({ settings, writeId: crypto.randomUUID() }))
      localStorage.setItem(ACCOUNT_SETTINGS_ACTIVE_KEY, accountId);
  } catch {
    /* Storage never blocks a preference change. */
  }
}
