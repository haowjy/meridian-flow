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
export interface ProjectPreferences {
  autoResume: { enabled: boolean; timeoutMs: number };
}
export const DEFAULT_PROJECT_PREFERENCES: ProjectPreferences = {
  autoResume: { enabled: true, timeoutMs: 270_000 },
};
export type UpdateProjectPreferencesRequest = Partial<ProjectPreferences>;
export interface ProjectPreferencesResponse {
  preferences: ProjectPreferences;
}
