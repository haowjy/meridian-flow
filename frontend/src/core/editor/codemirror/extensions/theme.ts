/**
 * Editor Theme
 *
 * SOLID: Single Responsibility - Only handles styling
 *
 * Provides the visual styling for the editor including:
 * - Base editor appearance
 * - Formatting styles (bold, italic, code, strikethrough, etc.)
 * - List marker widgets
 * - Heading styles
 * - Blockquotes, horizontal rules, tables
 */

import { EditorView } from '@codemirror/view'

// ============================================================================
// BASE THEME (structural defaults)
// ============================================================================

export const baseTheme = EditorView.baseTheme({
  '&.cm-editor': {
    // Use height: auto so the editor sizes to content, then content uses min-height
    // to fill the viewport. height: 100% doesn't work reliably with flexbox containers.
    // See: https://github.com/codemirror/dev/issues/472
    height: 'auto',
    outline: 'none', // Prevent global outline style from showing on focus
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
})

// ============================================================================
// LIVE PREVIEW THEME
// ============================================================================

export const livePreviewTheme = EditorView.theme({
  // Base editor styling
  '&': {
    fontSize: '16px',
    fontFamily: 'Georgia, serif',
  },
  '.cm-content': {
    // IMPORTANT: Keep `.cm-content` full-width so clicking in the left/right
    // whitespace still updates the cursor position (CM hit-testing is based on
    // coords inside the content DOM).
    paddingTop: '20px',
    paddingBottom: '20px',
    paddingLeft: 'max(20px, calc((100% - 720px) / 2))',
    paddingRight: 'max(20px, calc((100% - 720px) / 2))',
    // Use viewport-based min-height so clicking below content works.
    // 120px accounts for header (~40px), AI toolbar (~40px), and buffer (~40px).
    // This works because .cm-editor uses height: auto (see baseTheme).
    minHeight: 'calc(100vh - 120px)',
  },
  '.cm-gutter': {
    minHeight: 'calc(100vh - 120px)', // Match content height
  },
  '.cm-line': {
    lineHeight: '1.6',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--theme-accent, #d97706)',
    borderLeftWidth: '2px',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(217, 119, 6, 0.2)',
  },

  // Bold
  '.cm-strong': {
    fontWeight: 'bold',
  },

  // Italic
  '.cm-em': {
    fontStyle: 'italic',
  },

  // Inline code
  '.cm-inline-code': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: '0.9em',
    backgroundColor: 'var(--theme-surface, #f5f5f5)',
    padding: '2px 6px',
    borderRadius: '4px',
  },

  // Links
  '.cm-link': {
    color: 'var(--theme-accent, #d97706)',
    textDecoration: 'underline',
    textUnderlineOffset: '2px',
  },

  // Headings
  '.cm-heading': {
    fontWeight: 'bold',
    fontFamily: 'var(--theme-font-display, Georgia, serif)',
  },
  '.cm-heading-1': {
    fontSize: '2em',
    lineHeight: '1.3',
  },
  '.cm-heading-2': {
    fontSize: '1.5em',
    lineHeight: '1.4',
  },
  '.cm-heading-3': {
    fontSize: '1.25em',
    lineHeight: '1.5',
  },

  // List widgets
  '.cm-list-bullet-widget': {
    display: 'inline-block',
    width: '1.5em',
    color: 'var(--theme-text-muted, #78716c)',
    textAlign: 'center',
  },
  '.cm-list-number-widget': {
    display: 'inline-block',
    width: '1.5em',
    color: 'var(--theme-text-muted, #78716c)',
    textAlign: 'right',
    paddingRight: '0.25em',
  },

  // Code blocks
  '.cm-code-block': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: '0.9em',
    backgroundColor: 'var(--theme-surface, #f5f5f5)',
  },

  // Blockquotes
  '.cm-blockquote': {
    borderLeft: '3px solid var(--theme-accent, #d97706)',
    paddingLeft: '1em',
    color: 'var(--theme-text-muted, #78716c)',
    fontStyle: 'italic',
  },

  // Horizontal rule
  '.cm-hr-widget': {
    display: 'block',
    width: '100%',
    height: '2px',
    backgroundColor: 'var(--theme-border, #e5e5e5)',
    padding: '1em 0', // Use padding instead of margin to avoid breaking CM6 hit testing
  },

  // Strikethrough
  '.cm-strikethrough': {
    textDecoration: 'line-through',
    color: 'var(--theme-text-muted, #78716c)',
  },

  // Tables
  '.cm-table-row': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: '0.9em',
  },
  '.cm-table-header': {
    fontWeight: 'bold',
  },
})

// ============================================================================
// COMBINED THEME EXTENSION
// ============================================================================

export const editorTheme = [baseTheme, livePreviewTheme]
