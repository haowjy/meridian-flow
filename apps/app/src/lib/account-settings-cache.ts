/** Account-stamped first-paint cache. The server remains the preference authority. */
import { ACCOUNT_LANGUAGES, ACCOUNT_THEMES } from "@meridian/contracts/preferences";
import type { AccountSettings } from "@meridian/contracts/protocol";
export const ACCOUNT_SETTINGS_ACTIVE_KEY = "meridian:account-settings-active:v1";
export const ACCOUNT_SETTINGS_CACHE_PREFIX = "meridian:account-settings:v1:";
export function readAccountSettingsCache(accountId?: string): AccountSettings | null {
  try {
    const id = accountId ?? localStorage.getItem(ACCOUNT_SETTINGS_ACTIVE_KEY);
    if (!id) return null;
    const payload = JSON.parse(localStorage.getItem(ACCOUNT_SETTINGS_CACHE_PREFIX + id) ?? "null");
    const s = payload?.settings;
    return payload?.accountId === id &&
      ACCOUNT_LANGUAGES.includes(s?.language) &&
      ACCOUNT_THEMES.includes(s?.theme) &&
      typeof s?.statsForNerds === "boolean" &&
      typeof s?.workingSetSyncEnabled === "boolean"
      ? s
      : null;
  } catch {
    return null;
  }
}
export function writeAccountSettingsCache(accountId: string, settings: AccountSettings): void {
  try {
    localStorage.setItem(
      ACCOUNT_SETTINGS_CACHE_PREFIX + accountId,
      JSON.stringify({ accountId, settings }),
    );
    localStorage.setItem(ACCOUNT_SETTINGS_ACTIVE_KEY, accountId);
  } catch {
    /* Storage never blocks a preference change. */
  }
}
