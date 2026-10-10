/** Palette projection with an account-stamped, pre-paint cache. */
import { ACCOUNT_THEMES, type AccountTheme } from "@meridian/contracts/preferences";
import {
  ACCOUNT_SETTINGS_ACTIVE_KEY,
  ACCOUNT_SETTINGS_CACHE_PREFIX,
  readAccountSettingsCache,
} from "./account-settings-cache";
export const UI_THEMES = ACCOUNT_THEMES;
export type UiTheme = AccountTheme;
export const DEFAULT_UI_THEME: UiTheme = "ink-jade";
const listeners = new Set<() => void>();
let current: UiTheme | null = null;
export function resolveUiTheme(): UiTheme {
  if (typeof window === "undefined") return DEFAULT_UI_THEME;
  return current ?? readAccountSettingsCache()?.theme ?? DEFAULT_UI_THEME;
}
export function changeUiTheme(theme: UiTheme): void {
  current = theme;
  if (typeof document !== "undefined") {
    if (theme === DEFAULT_UI_THEME) document.documentElement.removeAttribute("data-ui-theme");
    else document.documentElement.setAttribute("data-ui-theme", theme);
  }
  for (const listener of listeners) listener();
}
export function subscribeUiTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function createUiThemeBootScript(seed?: { accountId: string; theme?: UiTheme }): string {
  return `(() => { try { const seed = ${JSON.stringify(seed ?? null)}; const id = seed?.accountId || localStorage.getItem(${JSON.stringify(ACCOUNT_SETTINGS_ACTIVE_KEY)}); const cache = JSON.parse(localStorage.getItem(${JSON.stringify(ACCOUNT_SETTINGS_CACHE_PREFIX)} + id) || "null"); const theme = id && cache?.accountId === id && ${JSON.stringify(UI_THEMES)}.includes(cache?.settings?.theme) ? cache.settings.theme : seed?.theme; const root = document.documentElement; if (theme === "dark") root.setAttribute("data-ui-theme", "dark"); else root.removeAttribute("data-ui-theme"); } catch { ${seed?.theme === "dark" ? 'document.documentElement.setAttribute("data-ui-theme", "dark");' : 'document.documentElement.removeAttribute("data-ui-theme");'} } })();`;
}
export const UI_THEME_BOOT_SCRIPT = createUiThemeBootScript();
