/**
 * UI-theme preference — local, pre-paint palette selection for the whole app.
 *
 * Device-local like text size: writers may want different palettes on
 * different screens. The default Ink & Jade light palette is represented by
 * the ABSENCE of the DOM attribute so the plain token path stays the default;
 * every other theme (currently Dark) is a `:root[data-ui-theme]` override
 * block in `@meridian/design-tokens/themes.css`. Components' Tailwind `dark:`
 * variants key off the same attribute (see globals.css).
 */
const UI_THEME_STORAGE_KEY = "meridian:ui-theme";
const UI_THEME_ATTRIBUTE = "data-ui-theme";

export const UI_THEMES = ["ink-jade", "dark"] as const;
export type UiTheme = (typeof UI_THEMES)[number];

export const DEFAULT_UI_THEME: UiTheme = "ink-jade";

const listeners = new Set<() => void>();

function isUiTheme(value: string): value is UiTheme {
  return (UI_THEMES as readonly string[]).includes(value);
}

function normalizeUiTheme(value: string | null | undefined): UiTheme {
  return value && isUiTheme(value) ? value : DEFAULT_UI_THEME;
}

export function resolveUiTheme(): UiTheme {
  if (typeof window === "undefined") return DEFAULT_UI_THEME;
  try {
    return normalizeUiTheme(localStorage.getItem(UI_THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_UI_THEME;
  }
}

function notifyUiThemeListeners(): void {
  for (const listener of listeners) listener();
}

function applyUiTheme(theme: UiTheme): void {
  if (typeof document === "undefined") return;
  if (theme === DEFAULT_UI_THEME) {
    document.documentElement.removeAttribute(UI_THEME_ATTRIBUTE);
    return;
  }
  document.documentElement.setAttribute(UI_THEME_ATTRIBUTE, theme);
}

function applyStoredUiTheme(): void {
  applyUiTheme(resolveUiTheme());
}

export function changeUiTheme(theme: UiTheme): void {
  applyUiTheme(theme);
  try {
    localStorage.setItem(UI_THEME_STORAGE_KEY, theme);
  } catch {
    // localStorage unavailable
  }
  notifyUiThemeListeners();
}

export function subscribeUiTheme(listener: () => void): () => void {
  listeners.add(listener);

  function onStorage(event: StorageEvent): void {
    if (event.key !== UI_THEME_STORAGE_KEY) return;
    applyStoredUiTheme();
    notifyUiThemeListeners();
  }

  if (typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }

  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

/* The non-default theme names, serialized for the boot script's validity
   check — the script must not trust arbitrary localStorage strings. */
const BOOT_THEMES = JSON.stringify(UI_THEMES.filter((theme) => theme !== DEFAULT_UI_THEME));

export const UI_THEME_BOOT_SCRIPT = `(() => { try { const key = ${JSON.stringify(
  UI_THEME_STORAGE_KEY,
)}; const attr = ${JSON.stringify(
  UI_THEME_ATTRIBUTE,
)}; const themes = ${BOOT_THEMES}; const value = localStorage.getItem(key); const root = document.documentElement; if (value && themes.includes(value)) root.setAttribute(attr, value); else root.removeAttribute(attr); } catch {} })();`;
