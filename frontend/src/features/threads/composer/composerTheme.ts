/**
 * Composer Theme
 *
 * Compact CM6 theme for the thread composer.
 * - max 200px height (auto-expand composer), no minHeight by default
 * - text-sm (14px), line-wrapping
 * - Pill widget CSS from shared pillStyles
 *
 * Consumers that need a minimum height (e.g., TurnInput's 2-line feel)
 * opt in via `composerInputMinHeight`.
 */

import { EditorView } from "@codemirror/view";
import { pillStylesTheme } from "@/core/editor/codemirror/extensions/pillStyles";

const composerSpecificTheme = EditorView.theme({
  // Editor container — compact, no outline
  "&.cm-editor": {
    fontSize: "14px",
    fontFamily: "var(--font-sans)",
    outline: "none",
  },
  "&.cm-editor.cm-focused": {
    outline: "none",
  },

  // Content area — compact padding, auto height
  ".cm-content": {
    padding: "5px 8px",
    caretColor: "var(--theme-text, currentColor)",
    cursor: "text",
  },

  // Scroller — auto height with overflow (consumers opt in to minHeight)
  ".cm-scroller": {
    overflow: "auto",
    maxHeight: "200px",
  },

  // Line styling
  ".cm-line": {
    lineHeight: "1.5",
    padding: "0",
  },

  // Cursor
  ".cm-cursor": {
    borderLeftColor: "var(--theme-text, currentColor)",
    borderLeftWidth: "1.5px",
  },

  // Selection
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--primary) 15%, transparent)",
  },

  // Placeholder — truncate to single line so cursor doesn't stretch to
  // the full height of a wrapped placeholder element
  ".cm-placeholder": {
    color: "color-mix(in srgb, var(--muted-foreground) 60%, transparent)",
    fontStyle: "normal",
    display: "inline-block !important",
    maxWidth: "100%",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    verticalAlign: "top",
  },

  // =========================================================================
  // READ-ONLY MODE (ComposerViewer)
  // =========================================================================

  // Default cursor instead of text cursor
  ".cm-read-only .cm-content": {
    cursor: "default",
  },
});

// Compose: composer-specific styles + shared pill styles
export const composerTheme = [composerSpecificTheme, pillStylesTheme];

// Opt-in 48px min height for the main composer (TurnInput) — gives a ~2-line feel
export const composerInputMinHeight = EditorView.theme({
  ".cm-scroller": {
    minHeight: "48px",
  },
});
