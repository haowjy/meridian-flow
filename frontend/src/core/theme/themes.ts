/**
 * Theme Presets
 *
 * Each preset defines a complete visual theme including colors, typography, and fonts.
 * Add new themes here by following the ThemePreset interface.
 */

import type { ThemePreset } from './types';

/**
 * Modern Literary Theme (Enhanced)
 * Cormorant Garamond + Source Serif 4 + Manrope
 * Warm paper with antique gold accent
 */
const modernLiterary: ThemePreset = {
  id: 'modern-literary',
  name: 'Modern Literary',
  description: 'Contemporary literary aesthetic with warm amber accents',
  colors: {
    light: {
      // Core - warm paper tones
      bg: '#F9F6F0',
      surface: '#FFFDF8',
      text: '#2C2418',
      textMuted: '#6B5D4D',
      border: '#E5DFD4',

      // Accent (antique gold)
      accent: '#C8973E',
      accentHover: '#B8872E',
      accentForeground: '#2C2418',

      // Primary (antique gold)
      primary: '#C8973E',
      primaryForeground: '#2C2418',

      // Feedback
      success: '#2D5A47',
      successForeground: '#FFFFFF',
      warning: '#DB9A30',
      warningForeground: '#2C2418',
      error: '#C4785A',
      errorForeground: '#FFFFFF',

      // Focus rings
      focusRingOuter: 'rgba(200, 151, 62, 0.35)',
      focusRingInner: 'rgba(200, 151, 62, 0.15)',

      // Sidebar
      sidebar: '#F3EFE7',
      sidebarForeground: '#2C2418',
      sidebarIcon: '#6B5D4D',
      sidebarAccent: '#EDE8DE',
      sidebarBorder: '#E5DFD4',

      // Shadows - warm lamp-like
      shadow1: 'rgba(44, 36, 24, 0.06) 0px 1px 2px, rgba(44, 36, 24, 0.04) 0px 2px 6px',
      shadow2: 'rgba(44, 36, 24, 0.08) 0px 4px 12px, rgba(200, 151, 62, 0.04) 0px 0px 20px',
      shadow3: 'rgba(44, 36, 24, 0.12) 0px 8px 24px, rgba(200, 151, 62, 0.06) 0px 0px 40px',

      // Selection
      selectionBg: 'rgba(200, 151, 62, 0.25)',
      selectionFg: '#2C2418',
    },
    dark: {
      // Core - espresso/ink tones (warm, not blue-shifted)
      bg: '#1C1917',
      surface: '#252220',
      text: '#F0EBE3',
      textMuted: '#A89E8E',
      border: '#3A3530',

      // Accent (warm amber)
      accent: '#E4B866',
      accentHover: '#F0C87A',
      accentForeground: '#1C1917',

      // Primary (amber)
      primary: '#E4B866',
      primaryForeground: '#1C1917',

      // Feedback
      success: '#4A8F72',
      successForeground: '#1C1917',
      warning: '#F0B042',
      warningForeground: '#1C1917',
      error: '#D4896B',
      errorForeground: '#1C1917',

      // Focus rings
      focusRingOuter: 'rgba(228, 184, 102, 0.30)',
      focusRingInner: 'rgba(228, 184, 102, 0.12)',

      // Sidebar
      sidebar: '#14120F',
      sidebarForeground: '#F0EBE3',
      sidebarIcon: '#A89E8E',
      sidebarAccent: '#1E1B18',
      sidebarBorder: '#3A3530',

      // Shadows (with subtle amber glow)
      shadow1: 'rgba(0, 0, 0, 0.30) 0px 1px 2px, rgba(228, 184, 102, 0.06) 0px 0px 0px 1px inset',
      shadow2: 'rgba(0, 0, 0, 0.45) 0px 4px 16px, rgba(228, 184, 102, 0.04) 0px 0px 30px',
      shadow3: 'rgba(0, 0, 0, 0.55) 0px 8px 32px, rgba(228, 184, 102, 0.06) 0px 0px 50px',

      // Selection
      selectionBg: 'rgba(228, 184, 102, 0.35)',
      selectionFg: '#F0EBE3',
    },
  },
  typography: {
    display: "'Cormorant Garamond', Georgia, serif",
    body: "'Source Serif 4', Georgia, serif",
    ui: "'Manrope', system-ui, sans-serif",
  },
  fonts: [
    {
      family: 'Cormorant Garamond',
      weights: [400, 500, 600],
      italic: true,
      url: 'https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap',
    },
    {
      family: 'Source Serif 4',
      weights: [400, 500, 600],
      italic: true,
      url: 'https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,500;0,8..60,600;1,8..60,400;1,8..60,500&display=swap',
    },
    {
      family: 'Manrope',
      weights: [400, 500, 600],
      italic: false,
      url: 'https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600&display=swap',
    },
  ],
  radius: 8,
};

/**
 * Classic Jade Theme (Original Meridian)
 * Literata + Inter
 * Jade/gold on parchment
 */
const classicJade: ThemePreset = {
  id: 'classic-jade',
  name: 'Classic Jade',
  description: 'Original Meridian theme with jade and gold accents',
  colors: {
    light: {
      // Core
      bg: '#F7F3EB',
      surface: '#FFFFFF',
      text: '#1C1A18',
      textMuted: '#8A7F6C',
      border: '#DDD6C8',

      // Accent (gold)
      accent: '#F4B41A',
      accentHover: '#E0A410',
      accentForeground: '#1C1A18',

      // Primary (dark jade)
      primary: '#356e5b',
      primaryForeground: '#FFFFFF',

      // Feedback
      success: '#356e5b',
      successForeground: '#FFFFFF',
      warning: '#EBA868',
      warningForeground: '#1C1A18',
      error: '#EBA868',
      errorForeground: '#1C1A18',

      // Focus rings
      focusRingOuter: 'rgba(53, 110, 91, 0.28)',
      focusRingInner: 'rgba(244, 180, 26, 0.12)',

      // Sidebar
      sidebar: '#e8f0ed',
      sidebarForeground: '#1C1A18',
      sidebarIcon: '#356e5b',
      sidebarAccent: '#dce8e3',
      sidebarBorder: '#356e5b',

      // Shadows
      shadow1: 'rgba(28, 26, 24, 0.06) 0px 1px 2px, rgba(28, 26, 24, 0.04) 0px 2px 6px',
      shadow2: 'rgba(28, 26, 24, 0.10) 0px 3px 8px, rgba(28, 26, 24, 0.06) 0px 6px 16px',
      shadow3: 'rgba(28, 26, 24, 0.18) 0px 8px 24px, rgba(28, 26, 24, 0.10) 0px 12px 32px',

      // Selection
      selectionBg: 'rgba(244, 180, 26, 0.3)',
      selectionFg: '#1C1A18',
    },
    dark: {
      // Core
      bg: '#2f2f2f',
      surface: '#353535',
      text: '#EAEAE7',
      textMuted: '#B6B0A2',
      border: '#2E332F',

      // Accent (warm gold)
      accent: '#E3C169',
      accentHover: '#F0D080',
      accentForeground: '#2f2f2f',

      // Primary (glow jade)
      primary: '#3CC8B4',
      primaryForeground: '#2f2f2f',

      // Feedback
      success: '#3CC8B4',
      successForeground: '#EAEAE7',
      warning: '#E0A15F',
      warningForeground: '#2f2f2f',
      error: '#E0A15F',
      errorForeground: '#2f2f2f',

      // Focus rings
      focusRingOuter: 'rgba(60, 200, 180, 0.22)',
      focusRingInner: 'rgba(227, 193, 105, 0.10)',

      // Sidebar
      sidebar: '#2a2a2a',
      sidebarForeground: '#EAEAE7',
      sidebarIcon: '#EAEAE7',
      sidebarAccent: '#353535',
      sidebarBorder: '#2E332F',

      // Shadows (with jade/gold hints)
      shadow1: 'rgba(0, 0, 0, 0.30) 0px 1px 2px, rgba(60, 200, 180, 0.10) 0px 0px 0px 1px inset',
      shadow2: 'rgba(0, 0, 0, 0.45) 0px 3px 10px, rgba(227, 193, 105, 0.10) 0px 0px 0px 1px inset',
      shadow3: 'rgba(0, 0, 0, 0.60) 0px 8px 28px, rgba(60, 200, 180, 0.12) 0px 0px 24px',

      // Selection
      selectionBg: 'rgba(227, 193, 105, 0.4)',
      selectionFg: '#EAEAE7',
    },
  },
  typography: {
    display: "'Literata', Georgia, serif",
    body: "'Literata', Georgia, serif",
    ui: "'Inter', system-ui, sans-serif",
  },
  fonts: [
    {
      family: 'Literata',
      weights: [400, 500, 700],
      italic: true,
      url: 'https://fonts.googleapis.com/css2?family=Literata:ital,wght@0,400;0,500;0,700;1,400;1,500&display=swap',
    },
    {
      family: 'Inter',
      weights: [400, 500, 700],
      italic: false,
      url: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;700&display=swap',
    },
  ],
  radius: 8,
};

/**
 * Academic Theme
 * EB Garamond + Spectral + DM Sans
 * Scholarly aesthetic
 */
const academic: ThemePreset = {
  id: 'academic',
  name: 'Academic',
  description: 'Scholarly aesthetic with classic typography',
  colors: {
    light: {
      ...modernLiterary.colors.light,
      // Same colors as modern-literary, different fonts
    },
    dark: {
      ...modernLiterary.colors.dark,
    },
  },
  typography: {
    display: "'EB Garamond', Georgia, serif",
    body: "'Spectral', Georgia, serif",
    ui: "'DM Sans', system-ui, sans-serif",
  },
  fonts: [
    {
      family: 'EB Garamond',
      weights: [400, 500, 600],
      italic: true,
      url: 'https://fonts.googleapis.com/css2?family=EB+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap',
    },
    {
      family: 'Spectral',
      weights: [400, 500, 600],
      italic: true,
      url: 'https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,400;0,500;0,600;1,400;1,500&display=swap',
    },
    {
      family: 'DM Sans',
      weights: [400, 500, 600],
      italic: false,
      url: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap',
    },
  ],
  radius: 8,
};

/**
 * All available theme presets
 */
export const THEME_PRESETS: Record<string, ThemePreset> = {
  'modern-literary': modernLiterary,
  'classic-jade': classicJade,
  academic: academic,
};

/**
 * Default theme ID
 */
export const DEFAULT_THEME_ID = 'modern-literary';

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
export function getAvailableThemes(): Array<{ id: string; name: string; description: string }> {
  return Object.values(THEME_PRESETS).map((theme) => ({
    id: theme.id,
    name: theme.name,
    description: theme.description,
  }));
}
