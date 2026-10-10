import { i18n, type Messages } from "@lingui/core";
import { ACCOUNT_LANGUAGES, type AccountLanguage } from "@meridian/contracts/preferences";
import { messages as enMessages } from "@/locales/en/messages";
import { messages as zhMessages } from "@/locales/zh/messages";
import { readAccountSettingsCache } from "./account-settings-cache";

/** The Lingui catalogs supported by the app. */
const CATALOGS = {
  en: enMessages,
  zh: zhMessages,
} satisfies Record<AccountLanguage, Messages>;

export type SupportedLocale = AccountLanguage;

export const DEFAULT_LOCALE: SupportedLocale = "en";

i18n.load(CATALOGS);
i18n.activate(DEFAULT_LOCALE);

function isSupportedLocale(val: string): val is SupportedLocale {
  return ACCOUNT_LANGUAGES.some((locale) => locale === val);
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
    return (
      resolveQueryLocale() ??
      readAccountSettingsCache()?.language ??
      readNavigatorLocale() ??
      DEFAULT_LOCALE
    );
  }
  return DEFAULT_LOCALE;
}

export function activateLocale(locale: SupportedLocale): void {
  if (i18n.locale === locale) return;
  i18n.activate(locale);
}

const LOCALE_LABELS: Record<SupportedLocale, string> = { en: "English", zh: "中文" };
export const SUPPORTED_LOCALES = ACCOUNT_LANGUAGES.map((code) => ({
  code,
  label: LOCALE_LABELS[code],
}));

export function changeLocale(locale: SupportedLocale): void {
  activateLocale(locale);
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

export { i18n };

export function resolveQueryLocale(): SupportedLocale | null {
  if (typeof window === "undefined") return null;
  const locale = new URLSearchParams(window.location.search).get("locale");
  return locale && isSupportedLocale(locale) ? locale : null;
}
