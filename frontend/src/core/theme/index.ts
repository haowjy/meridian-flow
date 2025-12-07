/**
 * Theme System
 *
 * Flexible theming for Meridian with support for multiple color schemes and typography.
 *
 * Usage:
 * ```tsx
 * // In your app root
 * import { ThemeProvider } from '@/core/theme';
 *
 * function App() {
 *   return (
 *     <ThemeProvider>
 *       <YourApp />
 *     </ThemeProvider>
 *   );
 * }
 *
 * // In components
 * import { useThemeContext } from '@/core/theme';
 *
 * function MyComponent() {
 *   const { themeId, setThemeId, isDark, setMode } = useThemeContext();
 *   // ...
 * }
 * ```
 *
 * Adding a new theme:
 * 1. Add a new ThemePreset object in themes.ts
 * 2. Add it to THEME_PRESETS record
 * 3. Theme will automatically appear in getAvailableThemes()
 */

// Types
export type { ThemeColors, ThemeFontConfig, ThemeMode, ThemePreset, ThemeState, ThemeTypography } from './types';

// Theme presets
export { DEFAULT_THEME_ID, getAvailableThemes, getThemePreset, THEME_PRESETS } from './themes';

// Font utilities
export { getFontFamilyWithFallbacks, isFontLoaded, loadThemeFonts, preloadThemeFonts, waitForFonts } from './fonts';

// React integration
export { ThemeProvider, useOptionalThemeContext, useThemeContext } from './ThemeProvider';
export { useTheme } from './useTheme';
