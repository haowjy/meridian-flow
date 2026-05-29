import { syntaxHighlighting } from "@codemirror/language"
import type { Extension } from "@codemirror/state"
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
} from "@codemirror/view"

import { meridianMarkdownHighlightStyle } from "./highlight"

const meridianEditorBaseTheme = EditorView.theme({
  "&": {
    height: "100%",
    color: "var(--foreground)",
    backgroundColor: "transparent",
    fontFamily: "var(--font-editor, 'iA Writer Quattro', Georgia, serif)",
    fontSize: "var(--editor-font-size)",
    lineHeight: "var(--editor-leading)",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "inherit",
    overflow: "auto",
    padding: "1.5rem 1.75rem",
  },
  ".cm-content": {
    caretColor: "var(--foreground)",
    fontFamily: "inherit",
    minHeight: "100%",
    paddingBottom: "40vh",
  },
  ".cm-line": {
    padding: "0",
  },
  ".cm-cursor, .cm-dropCursor": {
    borderLeftColor: "var(--foreground)",
  },
  "&.cm-focused": {
    outline: "none",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in oklab, var(--foreground) 14%, transparent)",
  },
  ".cm-activeLine": {
    backgroundColor: "color-mix(in oklab, var(--foreground) 4%, transparent)",
  },
  ".cm-gutters": {
    backgroundColor: "transparent",
    border: "none",
    color: "var(--muted-foreground)",
  },
  ".cm-gutterElement": {
    padding: "0 0.625rem 0 0",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "color-mix(in oklab, var(--foreground) 4%, transparent)",
    color: "var(--foreground)",
  },
  ".cm-placeholder": {
    color: "var(--muted-foreground)",
    fontStyle: "italic",
  },
  ".md-h1": {
    fontSize: "1.5em",
    fontWeight: "700",
    letterSpacing: "0.01em",
    lineHeight: "1.35",
  },
  ".md-h2": {
    fontSize: "1.3em",
    fontWeight: "700",
    lineHeight: "1.4",
  },
  ".md-h3": {
    fontSize: "1.15em",
    fontWeight: "600",
    lineHeight: "1.45",
  },
  ".md-h4, .md-h5, .md-h6": {
    fontWeight: "600",
  },
  ".md-strong": {
    fontWeight: "700",
  },
  ".md-emphasis": {
    fontStyle: "italic",
  },
  ".md-link": {
    color: "var(--accent-fill)",
    textDecoration: "underline",
    textUnderlineOffset: "0.14em",
    cursor: "pointer",
  },
  ".md-code-inline": {
    background: "var(--muted)",
    color: "var(--foreground)",
    fontFamily: "var(--font-mono)",
    padding: "1px 4px",
    borderRadius: "var(--radius-sm)",
    fontSize: "0.9em",
  },
  ".md-code-block": {
    background: "color-mix(in oklab, var(--muted) 90%, transparent)",
    border: "1px solid color-mix(in oklab, var(--border) 92%, transparent)",
    borderRadius: "var(--radius-xl)",
    color: "var(--foreground)",
    display: "block",
    fontFamily: "var(--font-mono)",
    fontSize: "0.92em",
    lineHeight: "1.65",
    margin: "0.6em 0",
    padding: "0.9em 1em",
    whiteSpace: "pre-wrap",
  },
  ".md-code-block-code": {
    display: "block",
  },
  ".md-code-block-lang": {
    color: "var(--muted-foreground)",
    display: "block",
    fontSize: "0.8em",
    marginBottom: "0.3em",
    opacity: "0.7",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  ".md-code-block-actions": {
    display: "flex",
    gap: "0.25em",
  },
  ".md-code-copy-btn": {
    background: "color-mix(in oklab, var(--foreground) 10%, transparent)",
    border: "1px solid color-mix(in oklab, var(--border) 80%, transparent)",
    borderRadius: "var(--radius-md)",
    color: "var(--muted-foreground)",
    cursor: "pointer",
    fontSize: "0.75em",
    padding: "0.2em 0.5em",
  },
  ".md-code-copy-btn:hover": {
    background: "color-mix(in oklab, var(--foreground) 16%, transparent)",
    color: "var(--foreground)",
  },
  ".md-code-block-line": {
    background: "color-mix(in oklab, var(--muted) 60%, transparent)",
    fontFamily: "var(--font-mono)",
    fontSize: "0.92em",
  },
  ".md-mermaid-placeholder": {
    color: "var(--muted-foreground)",
    fontStyle: "italic",
    fontSize: "0.9em",
    padding: "0.5em 0",
  },
  ".md-mermaid-svg": {
    display: "flex",
    justifyContent: "center",
  },
  ".md-mermaid-svg iframe": {
    border: "none",
    maxWidth: "100%",
  },
  ".md-blockquote": {
    borderLeft: "3px solid var(--border)",
    color: "var(--muted-foreground)",
    display: "inline-block",
    fontStyle: "italic",
    paddingLeft: "1em",
    width: "100%",
  },
  ".md-hr": {
    border: "none",
    borderTop: "1px solid var(--border)",
    display: "block",
    margin: "1em 0",
  },
  ".md-list-item": {
    listStyle: "none",
  },
  ".md-list-depth-1": {
    paddingLeft: "0.15em",
  },
  ".md-list-depth-2": {
    paddingLeft: "1.1em",
  },
  ".md-list-depth-3": {
    paddingLeft: "2.1em",
  },
  ".md-list-depth-4": {
    paddingLeft: "3.1em",
  },
  ".md-list-depth-5": {
    paddingLeft: "4.1em",
  },
  ".md-list-depth-6": {
    paddingLeft: "5.1em",
  },
  ".md-list-mark": {
    color: "var(--accent-text)",
    fontWeight: "600",
    opacity: "0.9",
  },
  ".md-image-wrapper": {
    display: "block",
    margin: "0.75rem 0",
  },
  ".md-image": {
    border: "1px solid color-mix(in oklab, var(--border) 90%, transparent)",
    borderRadius: "var(--radius-xl)",
    boxShadow: "var(--elevation-overlay)",
    cursor: "zoom-in",
    display: "block",
    height: "auto",
    maxWidth: "100%",
  },

  // --- Phase 1 Foundation: shared decoration classes ---

  // Hidden syntax markers (e.g., ** for bold, # for headings).
  // CSS-only transition -- no JS animation frames needed.
  // Hide is slightly slower (100ms) than reveal (80ms) so the user
  // sees syntax before their edit intention expires.
  ".md-hidden-syntax": {
    opacity: "0",
    transition: "opacity var(--duration-fast) var(--ease-out)",
  },
  ".md-hidden-syntax.md-revealed": {
    opacity: "1",
    transition: "opacity 80ms var(--ease-in)",
  },

  // Wrapper for atomic widget decorations (fenced code, mermaid, images).
  // Context menu and keyboard interaction handlers target this class.
  ".md-widget-wrapper": {
    position: "relative",
    display: "block",
  },

  // Hover overlay for edit affordance on embedded objects.
  // Fades in after 200ms, positioned top-right of widget.
  ".md-widget-overlay": {
    position: "absolute",
    top: "4px",
    right: "4px",
    opacity: "0",
    transition: "opacity var(--duration-moderate) var(--ease-out)",
    pointerEvents: "none",
  },
  ".md-widget-wrapper:hover .md-widget-overlay": {
    opacity: "0.7",
    pointerEvents: "auto",
  },

  // HR wrapper -- distinct from .md-widget-wrapper so context menu
  // and keyboard interaction handlers skip it
  ".md-hr-wrapper": {
    display: "block",
    position: "relative",
  },

  // Mermaid diagram block
  ".md-mermaid-block": {
    background: "color-mix(in oklab, var(--muted) 70%, transparent)",
    border: "1px solid color-mix(in oklab, var(--border) 92%, transparent)",
    borderRadius: "var(--radius-xl)",
    margin: "0.6em 0",
    minHeight: "60px",
    padding: "0.5em",
  },

  // External image placeholder (untrusted URLs)
  ".md-image-external-placeholder": {
    alignItems: "center",
    background: "color-mix(in oklab, var(--muted) 50%, transparent)",
    border: "1px dashed var(--border)",
    borderRadius: "var(--radius-xl)",
    color: "var(--muted-foreground)",
    display: "flex",
    flexDirection: "column",
    fontSize: "0.9em",
    gap: "0.5em",
    justifyContent: "center",
    margin: "0.75rem 0",
    minHeight: "80px",
    padding: "1.5em",
  },

  // Button to load external images
  ".md-image-load-btn": {
    background: "var(--accent-fill)",
    border: "none",
    borderRadius: "var(--radius-md)",
    color: "var(--primary-foreground)",
    cursor: "pointer",
    fontSize: "0.85em",
    padding: "0.4em 0.8em",
  },
  ".md-image-load-btn:hover": {
    opacity: "0.85",
  },
})

export const meridianEditorTheme: Extension = [
  meridianEditorBaseTheme,
  lineNumbers(),
  drawSelection(),
  highlightActiveLine(),
  highlightActiveLineGutter(),
  syntaxHighlighting(meridianMarkdownHighlightStyle),
]
