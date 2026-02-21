/**
 * Shiki Syntax Highlighter (Lazy Singleton)
 *
 * SOLID: Single Responsibility - Only handles syntax highlighting via Shiki
 *
 * Lazy-loads Shiki with dual themes (github-light + github-dark) matching
 * Streamdown's visual treatment. Languages are loaded on demand.
 * Once ready, dispatches a StateEffect to all registered EditorViews
 * so the live preview plugin rebuilds decorations with highlighted output.
 */

import { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { Highlighter } from "shiki";

type ShikiLoadLanguageArg = Parameters<Highlighter["loadLanguage"]>[0];
type ShikiCodeLang = Parameters<Highlighter["codeToTokens"]>[1]["lang"];

// ============================================================================
// PUBLIC TYPES
// ============================================================================

/** A single syntax token with inline style (dual-theme CSS var approach) */
export type ShikiToken = { content: string; style: string };

// ============================================================================
// STATE EFFECT (triggers decoration rebuild when Shiki loads)
// ============================================================================

/** Dispatched to all registered views when Shiki finishes loading */
export const shikiReadyEffect = StateEffect.define<null>();

// ============================================================================
// VIEW REGISTRY (views that need rebuild on Shiki load)
// ============================================================================

const registeredViews = new Set<EditorView>();

export function registerView(view: EditorView): void {
  registeredViews.add(view);
}

export function unregisterView(view: EditorView): void {
  registeredViews.delete(view);
}

/** Notify all registered views that Shiki is ready */
function notifyViews(): void {
  for (const view of registeredViews) {
    try {
      view.dispatch({ effects: shikiReadyEffect.of(null) });
    } catch {
      // View may have been destroyed — ignore
    }
  }
}

// ============================================================================
// HIGHLIGHTER SINGLETON
// ============================================================================

let highlighter: Highlighter | null = null;
let loading = false;
let ready = false;

/** Languages currently loaded into the highlighter */
const loadedLangs = new Set<string>();

/** Languages currently being loaded (prevents duplicate load calls) */
const pendingLangs = new Set<string>();

/** Simple LRU-ish cache: key = "lang\0code", value = token lines */
const cache = new Map<string, ShikiToken[][]>();
const CACHE_MAX = 100;

function cacheSet(key: string, value: ShikiToken[][]): void {
  if (cache.size >= CACHE_MAX) {
    // Delete oldest entry (first key in insertion order)
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(key, value);
}

/**
 * Bootstrap the Shiki highlighter (called once, lazily).
 *
 * Uses the JavaScript engine (no WASM) and dual themes for light/dark mode.
 * CSS variables (--shiki-dark, --shiki-dark-bg) handle dark mode switching.
 */
async function bootstrap(): Promise<void> {
  if (loading || ready) return;
  loading = true;

  try {
    const { createHighlighter } = await import("shiki");
    highlighter = await createHighlighter({
      themes: ["github-light", "github-dark"] as const,
      // Start with no languages — load on demand
      langs: [],
    });
    ready = true;
    notifyViews();
  } catch (err) {
    console.warn("[ShikiHighlighter] Failed to load:", err);
    loading = false;
  }
}

/**
 * Load a language into the highlighter if not already loaded.
 * Returns true if the language is ready for use.
 */
async function ensureLang(lang: string): Promise<boolean> {
  if (!highlighter || !ready) return false;
  if (loadedLangs.has(lang)) return true;
  if (pendingLangs.has(lang)) return false;

  pendingLangs.add(lang);
  try {
    await highlighter.loadLanguage(lang as ShikiLoadLanguageArg);
    loadedLangs.add(lang);
    pendingLangs.delete(lang);
    // Notify views so they rebuild with the newly available language
    notifyViews();
    return true;
  } catch {
    // Unknown language — mark as loaded so we don't retry
    pendingLangs.delete(lang);
    loadedLangs.add(lang);
    return false;
  }
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Tokenize code with Shiki for structured decoration output.
 *
 * Returns array of lines, each line = array of tokens with inline style strings.
 * Style strings contain both color + --shiki-dark CSS var (dual-theme).
 * Same approach as Streamdown's codeToTokens() for visual consistency.
 *
 * Returns null if Shiki isn't ready yet (first call triggers lazy bootstrap).
 *
 * @param code - The source code to tokenize
 * @param lang - Language identifier (e.g. "javascript", "python")
 */
export function tokenizeCode(
  code: string,
  lang: string,
): ShikiToken[][] | null {
  // Kick off bootstrap on first call
  if (!ready && !loading) {
    void bootstrap();
    return null;
  }

  if (!ready || !highlighter) return null;

  // Check cache first
  const cacheKey = `${lang}\0${code}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // If language isn't loaded yet, start loading and return null for now
  if (!loadedLangs.has(lang)) {
    void ensureLang(lang);
    return null;
  }

  try {
    const result = highlighter.codeToTokens(code, {
      lang: lang as ShikiCodeLang,
      themes: {
        light: "github-light",
        dark: "github-dark",
      },
      // cssVariablePrefix controls the CSS var names for dual-theme
      defaultColor: "light",
    });

    // Map Shiki's token structure to our flat ShikiToken format
    const tokenLines: ShikiToken[][] = result.tokens.map((line) =>
      line.map((token) => {
        // Build inline style from htmlStyle (includes both color and --shiki-dark var)
        const style = token.htmlStyle
          ? typeof token.htmlStyle === "string"
            ? token.htmlStyle
            : Object.entries(token.htmlStyle)
                .map(([k, v]) => `${k}:${v}`)
                .join(";")
          : "";
        return { content: token.content, style };
      }),
    );

    cacheSet(cacheKey, tokenLines);
    return tokenLines;
  } catch {
    // Language may not be supported — return null to fall back to plain text
    return null;
  }
}
