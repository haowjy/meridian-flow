/** The overlay's section keys — the legal values of the `?settings=` param. */
export const SETTINGS_SECTIONS = ["profile", "preferences", "usage"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export function isSettingsSection(value: unknown): value is SettingsSection {
  return typeof value === "string" && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}
