/**
 * Theme Presets
 *
 * Each preset defines a complete visual theme including colors, typography, and fonts.
 * Add new themes here by following the ThemePreset interface.
 */

import type { ThemePreset } from "./types";

/**
 * Modern Literary Theme (Enhanced)
 * Cormorant Garamond + Source Serif 4 + Manrope
 * Warm paper with sage green accent - calm, literary, natural
 */
const modernLiterary: ThemePreset = {
  id: "modern-literary",
  name: "Modern Literary",
  description: "Contemporary literary aesthetic with sage green accents",
  colors: {
    light: {
      // Core - warm paper tones (enhanced contrast)
      bg: "#F6F2EA", // Warmer, more distinguishable from white
      surface: "#FAF7F2", // Distinct from pure white
      text: "#1F1A12", // Darker for better contrast
      textMuted: "#5A4D3F", // Slightly darker muted text
      border: "#D8D0C2", // More visible borders

      // Favorite (gold - for starred items)
      favorite: "#F4B41A",
      favoriteHover: "#E0A410",
      favoriteForeground: "#1C1A18",

      // Primary (sage green - deeper, more confident)
      primary: "#4A7A68",
      primaryForeground: "#FFFFFF",

      // Feedback colors - usage guide:
      // - bg-X/10-20 (tinted bg) → use text-X (the color itself)
      // - bg-X (full bg) → use text-X-foreground (contrasting text)
      // Example: bg-error/10 + text-error ✓ | bg-error + text-error-foreground ✓
      success: "#3D8B5F",
      successForeground: "#FFFFFF", // Use ON bg-success (full background)
      warning: "#DB9A30",
      warningForeground: "#2C2418", // Use ON bg-warning (full background)
      error: "#B54425", // Warm terracotta red, 5.3:1 contrast on #F9F6F0
      errorForeground: "#FFFFFF", // Use ON bg-error (full background)

      // Focus rings (sage tint - updated to match new primary)
      focusRingOuter: "rgba(74, 122, 104, 0.35)",
      focusRingInner: "rgba(74, 122, 104, 0.15)",

      // Sidebar
      sidebar: "#F0EBE2", // Slightly warmer to match new bg
      sidebarForeground: "#1F1A12",
      sidebarIcon: "#5A4D3F",
      sidebarAccent: "#E8E3D9",
      sidebarBorder: "#D8D0C2",

      // Shadows - more visible, warmer (increased opacity)
      shadow1:
        "0 1px 3px rgba(44, 36, 24, 0.12), 0 1px 2px rgba(44, 36, 24, 0.08)",
      shadow2:
        "0 4px 12px rgba(44, 36, 24, 0.15), 0 2px 4px rgba(44, 36, 24, 0.10)",
      shadow3:
        "0 10px 25px rgba(44, 36, 24, 0.18), 0 4px 10px rgba(44, 36, 24, 0.12)",

      // Selection (sage tint - updated to match new primary)
      selectionBg: "rgba(74, 122, 104, 0.25)",
      selectionFg: "#1F1A12",
    },
    dark: {
      // Core - espresso/ink tones (warm, not blue-shifted)
      bg: "#1C1917",
      surface: "#2A2724", // Slightly lighter for better contrast
      text: "#F0EBE3",
      textMuted: "#A89E8E",
      border: "#3A3530",

      // Favorite (warm gold for dark mode)
      favorite: "#E3C169",
      favoriteHover: "#F0D080",
      favoriteForeground: "#2f2f2f",

      // Primary (brighter, more vibrant sage)
      primary: "#8FB9A4",
      primaryForeground: "#1C1917",

      // Feedback colors (see light mode for usage guide)
      success: "#5CB87A",
      successForeground: "#1C1917", // Use ON bg-success (full background)
      warning: "#F0B042",
      warningForeground: "#1C1917", // Use ON bg-warning (full background)
      error: "#E8735A", // Coral red, 5.8:1 contrast on #1C1917
      errorForeground: "#1C1917", // Use ON bg-error (full background)

      // Focus rings (sage tint - updated to match new primary)
      focusRingOuter: "rgba(143, 185, 164, 0.30)",
      focusRingInner: "rgba(143, 185, 164, 0.12)",

      // Sidebar
      sidebar: "#14120F",
      sidebarForeground: "#F0EBE3",
      sidebarIcon: "#A89E8E",
      sidebarAccent: "#2A2724", // Match new surface color
      sidebarBorder: "#3A3530",

      // Shadows - more visible with subtle sage glow
      shadow1:
        "0 1px 3px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.03)",
      shadow2:
        "0 4px 16px rgba(0, 0, 0, 0.45), 0 0 1px rgba(143, 185, 164, 0.08)",
      shadow3:
        "0 10px 30px rgba(0, 0, 0, 0.50), 0 0 20px rgba(143, 185, 164, 0.06)",

      // Selection (sage tint - updated to match new primary)
      selectionBg: "rgba(143, 185, 164, 0.35)",
      selectionFg: "#F0EBE3",
    },
  },
  typography: {
    display: "'Cormorant Garamond', Georgia, serif",
    body: "'Source Serif 4', Georgia, serif",
    ui: "'Manrope', system-ui, sans-serif",
  },
  fonts: [
    {
      family: "Cormorant Garamond",
      weights: [400, 500, 600],
      italic: true,
      url: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap",
    },
    {
      family: "Source Serif 4",
      weights: [400, 500, 600],
      italic: true,
      url: "https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,500;0,8..60,600;1,8..60,400;1,8..60,500&display=swap",
    },
    {
      family: "Manrope",
      weights: [400, 500, 600],
      italic: false,
      url: "https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600&display=swap",
    },
  ],
  radius: 8,
};

/**
 * All available theme presets
 */
export const THEME_PRESETS: Record<string, ThemePreset> = {
  "modern-literary": modernLiterary,
};

/**
 * Default theme ID
 */
export const DEFAULT_THEME_ID = "modern-literary";

/**
 * Get a theme preset by ID, falling back to default
 */
export function getThemePreset(id: string): ThemePreset {
  const theme = THEME_PRESETS[id];
  if (theme) return theme;
  // Default is always defined - we define it in this file
  return THEME_PRESETS[DEFAULT_THEME_ID] as ThemePreset;
}

/**
 * Get list of available themes for UI
 */
export function getAvailableThemes(): Array<{
  id: string;
  name: string;
  description: string;
}> {
  return Object.values(THEME_PRESETS).map((theme) => ({
    id: theme.id,
    name: theme.name,
    description: theme.description,
  }));
}
