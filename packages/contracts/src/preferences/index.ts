/** Shared account appearance settings and project runtime preferences. */
export const ACCOUNT_LANGUAGES = ["en", "zh"] as const;
export type AccountLanguage = (typeof ACCOUNT_LANGUAGES)[number];
export const ACCOUNT_THEMES = ["ink-jade", "dark"] as const;
export type AccountTheme = (typeof ACCOUNT_THEMES)[number];
export interface AccountAppearancePreferences {
  language: AccountLanguage;
  theme: AccountTheme;
  statsForNerds: boolean;
}
export const DEFAULT_ACCOUNT_APPEARANCE: AccountAppearancePreferences = {
  language: "en",
  theme: "ink-jade",
  statsForNerds: false,
};
