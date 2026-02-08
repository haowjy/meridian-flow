/**
 * Shared Pill & Inline Reference Styles
 *
 * Two rendering modes for references:
 *
 * 1. **Inline refs** (`.cm-inline-ref`) — document editor wiki-links.
 *    Mark-based: styled real text, selection flows through naturally.
 *
 * 2. **Pill widgets** (`.cm-inline-pill`) — composer inline elements.
 *    Replace-based: ORC placeholder + Decoration.replace widget.
 *
 * Classes:
 * - `.cm-inline-ref` — mark decoration on display text (editor)
 * - `.cm-inline-ref-broken` — broken link variant
 * - `.cm-ref-icon` — file icon point widget
 * - `.cm-ref-ai-insertion` / `.cm-ref-ai-deletion` — AI change styling
 * - `.cm-inline-pill` — container (composer pills)
 * - `.cm-inline-pill-icon` — leading icon (composer)
 * - `.cm-inline-pill-name` — display name (composer)
 * - `.cm-inline-pill-remove` — X button (composer only)
 * - `.cm-wiki-broken` — broken link variant (composer pills)
 */

import { EditorView } from "@codemirror/view";

export const pillStylesTheme = EditorView.theme({
  // =========================================================================
  // INLINE REF — mark-based text decorations (document editor)
  // =========================================================================

  // Icon + mark text form one unified chip via split-border trick:
  //   <span class="cm-ref-icon">📄</span><span class="cm-inline-ref">Name</span>
  //   ↑ left half of chip                  ↑ right half of chip

  ".cm-ref-icon": {
    display: "inline-flex",
    alignItems: "center",
    verticalAlign: "middle",
    backgroundColor: "var(--muted)",
    borderTop: "1px solid var(--border)",
    borderBottom: "1px solid var(--border)",
    borderLeft: "1px solid var(--border)",
    borderRight: "none",
    borderRadius: "3px 0 0 3px",
    padding: "1px 0 1px 4px",
    opacity: "0.7",
    transition: "background-color 120ms ease",
  },

  ".cm-ref-icon-broken": {
    opacity: "0.4",
    borderStyle: "dashed",
  },

  ".cm-inline-ref": {
    backgroundColor: "var(--muted)",
    borderTop: "1px solid var(--border)",
    borderBottom: "1px solid var(--border)",
    borderRight: "1px solid var(--border)",
    borderLeft: "none",
    borderRadius: "0 3px 3px 0",
    padding: "1px 4px 1px 2px",
    cursor: "pointer",
    transition: "background-color 120ms ease",
  },

  ".cm-inline-ref:hover": {
    backgroundColor: "color-mix(in srgb, var(--muted) 80%, var(--primary))",
  },

  // Broken wiki-link: document not found
  ".cm-inline-ref-broken": {
    textDecoration: "underline dashed",
    opacity: "0.6",
    borderStyle: "dashed",
  },

  // AI insertion: ref was added by an AI edit
  ".cm-ref-ai-insertion": {
    backgroundColor: "color-mix(in srgb, var(--success) 12%, transparent)",
  },

  // AI deletion: ref was removed by an AI edit
  ".cm-ref-ai-deletion": {
    backgroundColor: "color-mix(in srgb, var(--error) 12%, transparent)",
    textDecoration: "line-through",
    opacity: "0.7",
  },

  // =========================================================================
  // PILL WIDGETS — replace-based decorations (composer)
  // =========================================================================

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

  // Broken wiki-link: document not found (composer pills)
  ".cm-wiki-broken": {
    opacity: "0.6",
    borderStyle: "dashed",
  },

  // AI insertion: pill was added by an AI edit
  ".cm-pill-ai-insertion": {
    borderColor: "var(--success)",
    backgroundColor: "color-mix(in srgb, var(--success) 12%, var(--muted))",
    boxShadow: "0 0 0 1px color-mix(in srgb, var(--success) 25%, transparent)",
  },

  // AI deletion: pill was removed by an AI edit
  ".cm-pill-ai-deletion": {
    borderColor: "var(--error)",
    backgroundColor: "color-mix(in srgb, var(--error) 12%, var(--muted))",
    textDecoration: "line-through",
    opacity: "0.7",
  },
});
