/**
 * useTheme Hook
 *
 * Manages theme state and applies CSS variables to the document.
 * Persists user preferences to localStorage.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ThemeColors, ThemeMode, ThemePreset } from './types';
import { DEFAULT_THEME_ID, getThemePreset, THEME_PRESETS } from './themes';
import { loadThemeFonts } from './fonts';

const STORAGE_KEY_THEME = 'meridian-theme-id';
const STORAGE_KEY_MODE = 'meridian-theme-mode';

/**
 * Get system color scheme preference
 */
function getSystemMode(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Subscribe to system color scheme changes
 */
function subscribeToSystemMode(callback: () => void): () => void {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', callback);
  return () => mediaQuery.removeEventListener('change', callback);
}

/**
 * Apply theme CSS variables to document root
 */
function applyThemeColors(colors: ThemeColors, mode: 'light' | 'dark'): void {
  const root = document.documentElement;

  // Core colors
  root.style.setProperty('--theme-bg', colors.bg);
  root.style.setProperty('--theme-surface', colors.surface);
  root.style.setProperty('--theme-text', colors.text);
  root.style.setProperty('--theme-text-muted', colors.textMuted);
  root.style.setProperty('--theme-border', colors.border);

  // Accent
  root.style.setProperty('--theme-accent', colors.accent);
  root.style.setProperty('--theme-accent-hover', colors.accentHover);
  root.style.setProperty('--theme-accent-foreground', colors.accentForeground);

  // Primary
  root.style.setProperty('--theme-primary', colors.primary);
  root.style.setProperty('--theme-primary-foreground', colors.primaryForeground);

  // Feedback
  root.style.setProperty('--theme-success', colors.success);
  root.style.setProperty('--theme-success-foreground', colors.successForeground);
  root.style.setProperty('--theme-warning', colors.warning);
  root.style.setProperty('--theme-warning-foreground', colors.warningForeground);
  root.style.setProperty('--theme-error', colors.error);
  root.style.setProperty('--theme-error-foreground', colors.errorForeground);

  // Focus rings
  root.style.setProperty('--theme-focus-ring-outer', colors.focusRingOuter);
  root.style.setProperty('--theme-focus-ring-inner', colors.focusRingInner);

  // Sidebar
  root.style.setProperty('--theme-sidebar', colors.sidebar);
  root.style.setProperty('--theme-sidebar-foreground', colors.sidebarForeground);
  root.style.setProperty('--theme-sidebar-icon', colors.sidebarIcon);
  root.style.setProperty('--theme-sidebar-accent', colors.sidebarAccent);
  root.style.setProperty('--theme-sidebar-border', colors.sidebarBorder);

  // Shadows
  root.style.setProperty('--theme-shadow-1', colors.shadow1);
  root.style.setProperty('--theme-shadow-2', colors.shadow2);
  root.style.setProperty('--theme-shadow-3', colors.shadow3);

  // Selection
  root.style.setProperty('--theme-selection-bg', colors.selectionBg);
  root.style.setProperty('--theme-selection-fg', colors.selectionFg);

  // Apply dark class for Tailwind
  if (mode === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

/**
 * Apply theme typography to document root
 */
function applyThemeTypography(typography: ThemePreset['typography']): void {
  const root = document.documentElement;
  root.style.setProperty('--theme-font-display', typography.display);
  root.style.setProperty('--theme-font-body', typography.body);
  root.style.setProperty('--theme-font-ui', typography.ui);
}

/**
 * Apply theme radius to document root
 */
function applyThemeRadius(radius: number): void {
  const root = document.documentElement;
  root.style.setProperty('--theme-radius', `${radius}px`);
}

/**
 * Main theme hook
 */
export function useTheme() {
  // Theme ID state
  const [themeId, setThemeIdState] = useState<string>(() => {
    if (typeof window === 'undefined') return DEFAULT_THEME_ID;
    return localStorage.getItem(STORAGE_KEY_THEME) ?? DEFAULT_THEME_ID;
  });

  // Mode state
  const [mode, setModeState] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'system';
    return (localStorage.getItem(STORAGE_KEY_MODE) as ThemeMode) ?? 'system';
  });

  // System mode (reactive to OS changes)
  const systemMode = useSyncExternalStore(
    subscribeToSystemMode,
    getSystemMode,
    () => 'light' as const
  );

  // Resolved mode (actual light/dark after considering system preference)
  const resolvedMode = mode === 'system' ? systemMode : mode;

  // Get current theme preset
  const theme = useMemo(() => getThemePreset(themeId), [themeId]);

  // Set theme ID (with persistence)
  const setThemeId = useCallback((id: string) => {
    if (!THEME_PRESETS[id]) {
      console.warn(`Unknown theme ID: ${id}, falling back to default`);
      id = DEFAULT_THEME_ID;
    }
    localStorage.setItem(STORAGE_KEY_THEME, id);
    setThemeIdState(id);
  }, []);

  // Set mode (with persistence)
  const setMode = useCallback((newMode: ThemeMode) => {
    localStorage.setItem(STORAGE_KEY_MODE, newMode);
    setModeState(newMode);
  }, []);

  // Apply theme when it changes
  useEffect(() => {
    const colors = resolvedMode === 'dark' ? theme.colors.dark : theme.colors.light;
    applyThemeColors(colors, resolvedMode);
    applyThemeTypography(theme.typography);
    applyThemeRadius(theme.radius);
    loadThemeFonts(theme.fonts);
  }, [theme, resolvedMode]);

  return {
    // Current state
    themeId,
    mode,
    resolvedMode,
    theme,

    // Setters
    setThemeId,
    setMode,

    // Convenience
    isDark: resolvedMode === 'dark',
    isLight: resolvedMode === 'light',
  };
}
