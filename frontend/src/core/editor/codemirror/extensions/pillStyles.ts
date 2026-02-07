/**
 * Shared Pill Widget Styles
 *
 * Extracted from composerTheme.ts so both the thread composer and document
 * editor wiki-links share the same pill appearance from one source.
 *
 * Classes:
 * - `.cm-inline-pill` — container (muted bg, rounded, truncated)
 * - `.cm-inline-pill-icon` — leading icon
 * - `.cm-inline-pill-name` — display name (ellipsis overflow)
 * - `.cm-inline-pill-remove` — X button (composer only)
 * - `.cm-wiki-broken` — broken link variant (dashed border, dimmed)
 */

import { EditorView } from "@codemirror/view";

export const pillStylesTheme = EditorView.theme({
  ".cm-inline-pill": {
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    backgroundColor: "var(--muted)",
    color: "var(--muted-foreground)",
    border: "1px solid var(--border)",
    borderRadius: "4px",
    padding: "2px 6px 2px 5px",
    fontSize: "12px",
    lineHeight: "1.4",
    maxWidth: "180px",
    verticalAlign: "middle",
    cursor: "pointer",
    userSelect: "none",
    transition: "background-color 120ms ease",
  },

  ".cm-inline-pill:hover": {
    backgroundColor: "rgba(120, 113, 108, 0.15)",
  },

  ".cm-inline-pill-icon": {
    display: "inline-flex",
    alignItems: "center",
    flexShrink: "0",
    opacity: "0.7",
  },

  ".cm-inline-pill-name": {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  ".cm-inline-pill-remove": {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: "0",
    width: "14px",
    height: "14px",
    borderRadius: "2px",
    border: "none",
    background: "transparent",
    opacity: "0.5",
    cursor: "pointer",
    padding: "0",
    marginLeft: "1px",
  },
  ".cm-inline-pill-remove:hover": {
    color: "var(--foreground)",
    opacity: "1",
    backgroundColor: "rgba(120, 113, 108, 0.1)",
  },

  // Broken wiki-link: document not found
  ".cm-wiki-broken": {
    opacity: "0.6",
    borderStyle: "dashed",
  },
});
