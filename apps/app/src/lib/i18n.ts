import { i18n } from "@lingui/core";

import { messages as enMessages } from "@/locales/en/messages";
import { messages as zhMessages } from "@/locales/zh/messages";

/**
 * The Lingui catalogs supported by the app. Adding a locale is a config-only
 * change:
 * 1. Drop a new `.po` at `src/locales/<code>/messages.po`.
 * 2. Add the code to `lingui.config.ts` `locales`.
 * 3. Run `pnpm --filter @meridian/app lingui:extract && pnpm lingui:compile`.
 * 4. Add the entry below.
 *
 * No component-site code changes are required.
 */
const CATALOGS = {
  en: enMessages,
  zh: zhMessages,
} as const;

export type SupportedLocale = keyof typeof CATALOGS;

export const DEFAULT_LOCALE: SupportedLocale = "en";

i18n.load({ en: enMessages, zh: zhMessages });
i18n.activate(DEFAULT_LOCALE);

const LOCAL_STORAGE_KEY = "meridian.locale";

function isSupportedLocale(val: string): val is SupportedLocale {
  return val in CATALOGS;
}

function readStoredLocale(): SupportedLocale | null {
  try {
    const stored = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (stored && isSupportedLocale(stored)) return stored;
  } catch {
    // localStorage unavailable (SSR, privacy mode)
  }
  return null;
}

/**
 * Match the browser's preferred languages (`navigator.languages`) against
 * `SupportedLocale`. Each candidate is normalised by taking the BCP-47 primary
 * subtag (`"zh-CN"` → `"zh"`, `"en-US"` → `"en"`). First match wins; returns
 * `null` if no supported language is in the list.
 */
function readNavigatorLocale(): SupportedLocale | null {
  if (typeof navigator === "undefined") return null;
  const candidates = navigator.languages ?? (navigator.language ? [navigator.language] : []);
  for (const tag of candidates) {
    const primary = tag.toLowerCase().split("-")[0];
    if (primary && isSupportedLocale(primary)) return primary;
  }
  return null;
}

/**
 * Locale-resolution seam.
 *
 * Client-side resolution order (first match wins):
 *
 * 1. `?locale=` query param — explicit override; persisted to localStorage so
 *    subsequent visits stay on the chosen locale.
 * 2. `localStorage("meridian.locale")` — the user's stored preference (from the
 *    Account picker or a previous `?locale=` visit).
 * 3. `navigator.languages` — the browser's preferred languages, matched on
 *    the BCP-47 primary subtag (`"zh-CN"` → `"zh"`).
 * 4. `DEFAULT_LOCALE` — final fallback.
 *
 * On the **server** (SSR): always return `DEFAULT_LOCALE`. Client activation
 * is deferred to a `useEffect` in `__root.tsx` to avoid SSR/client hydration
 * mismatch on `I18nProvider`.
 *
 * When user-account-scoped preferences land (account metadata or a Meridian
 * profiles table), insert them between steps 2 and 3 — explicit choice on
 * *this* device beats account preference (someone using a borrowed machine),
 * but account preference beats the borrowed machine's browser language.
 *
 * Keep the function pure and synchronous so SSR + client agree on the active
 * locale during hydration (mismatches cause React hydration errors).
 *
 * `request` is intentionally typed as `unknown`. Today the function ignores
 * it, but when we wire up Accept-Language / cookie negotiation we'll narrow
 * to whatever Nitro / TanStack Start surfaces (`Request` headers).
 */
export function resolveLocale(_request?: unknown): SupportedLocale {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    const queryLocale = params.get("locale");
    if (queryLocale && isSupportedLocale(queryLocale)) {
      try {
        localStorage.setItem(LOCAL_STORAGE_KEY, queryLocale);
      } catch {
        // localStorage unavailable
      }
      return queryLocale;
    }
    return readStoredLocale() ?? readNavigatorLocale() ?? DEFAULT_LOCALE;
  }
  return DEFAULT_LOCALE;
}

/**
 * Activate a locale on the shared `i18n` instance. Safe to call from a route
 * loader before render — it switches the active catalog so `<I18nProvider>`
 * picks up the right messages on both SSR and hydration.
 */
export function activateLocale(locale: SupportedLocale): void {
  if (i18n.locale === locale) return;
  i18n.activate(locale);
}

/**
 * Locale metadata for UI surfaces (pickers, language menus). Each label is the
 * language's own endonym — convention is to show a locale's name in its own
 * tongue so users can recognize their language regardless of the current UI.
 */
export const SUPPORTED_LOCALES: ReadonlyArray<{
  code: SupportedLocale;
  label: string;
}> = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
];

/**
 * User-driven locale change. Activates the catalog, persists the choice to
 * localStorage, and syncs `<html lang>` for assistive tech + browser features
 * (hyphenation, voice, search engines). Use this from settings UI; loaders use
 * `activateLocale` directly.
 */
export function changeLocale(locale: SupportedLocale): void {
  activateLocale(locale);
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, locale);
  } catch {
    // localStorage unavailable
  }
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export { i18n };
