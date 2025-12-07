/**
 * ThemeProvider
 *
 * React context provider for theme state.
 * Wrap your app with this to enable theme switching.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { useTheme } from './useTheme';
import type { ThemeMode, ThemePreset } from './types';

interface ThemeContextValue {
  /** Current theme preset ID */
  themeId: string;
  /** Current mode setting (light/dark/system) */
  mode: ThemeMode;
  /** Resolved mode after system preference (light/dark only) */
  resolvedMode: 'light' | 'dark';
  /** Current theme preset object */
  theme: ThemePreset;
  /** Set theme by ID */
  setThemeId: (id: string) => void;
  /** Set mode */
  setMode: (mode: ThemeMode) => void;
  /** Convenience: is dark mode active */
  isDark: boolean;
  /** Convenience: is light mode active */
  isLight: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

interface ThemeProviderProps {
  children: ReactNode;
}

/**
 * Theme provider component
 * Place at the root of your app
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  const themeState = useTheme();

  return <ThemeContext.Provider value={themeState}>{children}</ThemeContext.Provider>;
}

/**
 * Hook to access theme context
 * Must be used within ThemeProvider
 */
export function useThemeContext(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error('useThemeContext must be used within a ThemeProvider');
  }
  return context;
}

/**
 * Safe hook that returns null if not in provider
 * Useful for optional theme awareness
 */
export function useOptionalThemeContext(): ThemeContextValue | null {
  return useContext(ThemeContext);
}
