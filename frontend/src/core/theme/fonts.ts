/**
 * Font Loading Utilities
 *
 * Handles dynamic loading of Google Fonts based on the active theme.
 * Uses link preload for critical fonts and cleanup of unused fonts.
 */

import type { ThemeFontConfig } from './types';

const FONT_LINK_PREFIX = 'meridian-theme-font-';

/**
 * Load fonts for a theme
 * Removes old theme fonts and loads new ones
 */
export function loadThemeFonts(fonts: ThemeFontConfig[]): void {
  // Remove existing theme font links
  const existingLinks = document.querySelectorAll(`link[id^="${FONT_LINK_PREFIX}"]`);
  existingLinks.forEach((link) => link.remove());

  // Add new font links
  fonts.forEach((font, index) => {
    const link = document.createElement('link');
    link.id = `${FONT_LINK_PREFIX}${index}`;
    link.rel = 'stylesheet';
    link.href = font.url;
    document.head.appendChild(link);
  });
}

/**
 * Preload fonts for faster initial render
 * Call this early in app lifecycle (e.g., in index.html or early in main.tsx)
 */
export function preloadThemeFonts(fonts: ThemeFontConfig[]): void {
  fonts.forEach((font) => {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'style';
    link.href = font.url;
    document.head.appendChild(link);
  });
}

/**
 * Check if a specific font family is loaded
 */
export async function isFontLoaded(family: string): Promise<boolean> {
  try {
    await document.fonts.load(`16px "${family}"`);
    return document.fonts.check(`16px "${family}"`);
  } catch {
    return false;
  }
}

/**
 * Wait for all theme fonts to be loaded
 * Useful for preventing FOUT (Flash of Unstyled Text)
 */
export async function waitForFonts(fonts: ThemeFontConfig[]): Promise<void> {
  const checks = fonts.map((font) => isFontLoaded(font.family));
  await Promise.all(checks);
}

/**
 * Get a comma-separated font-family string with fallbacks
 */
export function getFontFamilyWithFallbacks(
  primary: string,
  fallbacks: string[] = ['Georgia', 'serif']
): string {
  return [primary, ...fallbacks].map((f) => (f.includes(' ') ? `'${f}'` : f)).join(', ');
}
