/**
 * Shared Pill & Inline Reference Styles
 *
 * Two rendering modes for references:
 *
 * 1. **Inline refs** (`.cm-inline-ref`) — document editor wiki-links.
 *    Mark-based: styled real text, selection flows through naturally.
 *    File icon rendered via CSS `::before` pseudo-element (mask-image).
 *
 * 2. **Pill widgets** (`.cm-inline-pill`) — composer inline elements.
 *    Replace-based: ORC placeholder + Decoration.replace widget.
 *
 * Classes:
 * - `.cm-inline-ref` — mark decoration on display text (editor)
 * - `.cm-inline-ref-broken` — broken link variant
 * - `.cm-inline-pill` — container (composer pills)
 * - `.cm-inline-pill-icon` — leading icon (composer)
 * - `.cm-inline-pill-name` — display name (composer)
 * - `.cm-inline-pill-remove` — X button (composer only)
 * - `.cm-wiki-broken` — broken link variant (composer pills)
 */

import { EditorView } from "@codemirror/view";

// FileText SVG as a data URI for CSS mask-image.
// Using black stroke so the mask alpha channel picks up the icon shape.
// backgroundColor: currentColor then provides the actual color, adapting to light/dark.
const FILE_ICON_DATA_URI =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z'/%3E%3Cpath d='M14 2v4a2 2 0 0 0 2 2h4'/%3E%3Cpath d='M10 9H8'/%3E%3Cpath d='M16 13H8'/%3E%3Cpath d='M16 17H8'/%3E%3C/svg%3E\")";

export const pillStylesTheme = EditorView.theme({
  // =========================================================================
  // INLINE REF — mark-based text decorations (document editor)
  // =========================================================================

  // Single-element chip: the ::before pseudo-element renders the file icon
  // via CSS mask-image, so icon + text are one DOM element with unified
  // border, background, and hover behavior.

  ".cm-inline-ref": {
    backgroundColor: "var(--muted)",
    border: "1px solid var(--border)",
    borderRadius: "3px",
    padding: "1px 4px 1px 4px",
    cursor: "pointer",
    transition: "background-color 120ms ease",
  },

  // File icon via CSS mask — scales with font, adapts color via currentColor
  ".cm-inline-ref::before": {
    content: '""',
    display: "inline-block",
    width: "0.75em",
    height: "0.75em",
    backgroundColor: "currentColor",
    maskImage: FILE_ICON_DATA_URI,
    WebkitMaskImage: FILE_ICON_DATA_URI,
    maskSize: "contain",
    WebkitMaskSize: "contain",
    maskRepeat: "no-repeat",
    WebkitMaskRepeat: "no-repeat",
    verticalAlign: "middle",
    marginRight: "2px",
    opacity: "0.7",
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
