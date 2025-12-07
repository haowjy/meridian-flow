/**
 * Theme System Type Definitions
 *
 * Defines the structure for theme presets, colors, and typography.
 * All themes must implement these interfaces to ensure compatibility.
 */

export interface ThemeColors {
  // Core
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  border: string;

  // Accent
  accent: string;
  accentHover: string;
  accentForeground: string;

  // Primary (for buttons, interactive elements)
  primary: string;
  primaryForeground: string;

  // Feedback
  success: string;
  successForeground: string;
  warning: string;
  warningForeground: string;
  error: string;
  errorForeground: string;

  // Focus rings
  focusRingOuter: string;
  focusRingInner: string;

  // Sidebar
  sidebar: string;
  sidebarForeground: string;
  sidebarIcon: string;
  sidebarAccent: string;
  sidebarBorder: string;

  // Shadows (CSS shadow values, not colors)
  shadow1: string;
  shadow2: string;
  shadow3: string;

  // Selection
  selectionBg: string;
  selectionFg: string;
}

export interface ThemeTypography {
  /** Display/heading font family */
  display: string;
  /** Body text font family */
  body: string;
  /** UI/label font family */
  ui: string;
}

export interface ThemeFontConfig {
  family: string;
  weights: number[];
  italic: boolean;
  /** Google Fonts URL */
  url: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  colors: {
    light: ThemeColors;
    dark: ThemeColors;
  };
  typography: ThemeTypography;
  /** Font configurations for dynamic loading */
  fonts: ThemeFontConfig[];
  /** Default border radius in pixels */
  radius: number;
}

export type ThemeMode = 'light' | 'dark' | 'system';

export interface ThemeState {
  /** Current theme preset ID */
  themeId: string;
  /** Light/dark/system mode */
  mode: ThemeMode;
  /** Resolved mode (light or dark, after system preference) */
  resolvedMode: 'light' | 'dark';
}
