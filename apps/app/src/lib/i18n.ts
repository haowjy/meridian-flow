import { i18n } from "@lingui/core";

import { messages as enMessages } from "@/locales/en/messages";
import { messages as zhMessages } from "@/locales/zh/messages";

/** The Lingui catalogs supported by the app. */
const CATALOGS = {
  en: enMessages,
  zh: zhMessages,
} as const;

export type SupportedLocale = keyof typeof CATALOGS;

export const DEFAULT_LOCALE: SupportedLocale = "en";

i18n.load({ en: enMessages, zh: zhMessages });
i18n.activate(DEFAULT_LOCALE);

const LOCAL_STORAGE_KEY = "meridian:locale";

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

function readNavigatorLocale(): SupportedLocale | null {
  if (typeof navigator === "undefined") return null;
  const candidates = navigator.languages ?? (navigator.language ? [navigator.language] : []);
  for (const tag of candidates) {
    const primary = tag.toLowerCase().split("-")[0];
    if (primary && isSupportedLocale(primary)) return primary;
  }
  return null;
}

/** Locale-resolution seam. */
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

export function activateLocale(locale: SupportedLocale): void {
  if (i18n.locale === locale) return;
  i18n.activate(locale);
}

export const SUPPORTED_LOCALES: ReadonlyArray<{
  code: SupportedLocale;
  label: string;
}> = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
];

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
