import { Compartment } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'

/**
 * Compartment for theme configuration.
 * Allows switching between different themes at runtime.
 *
 * This follows ISP - theme configuration is separate from
 * other editor features.
 */
export const themeCompartment = new Compartment()

/**
 * Create the base Meridian theme.
 * Uses CSS variables for consistent styling with the app.
 */
export function createBaseTheme(): Extension {
  return EditorView.theme({
    '&': {
      fontSize: '15px',
      fontFamily: 'var(--font-serif, Georgia, serif)',
      backgroundColor: 'transparent',
    },
    '.cm-content': {
      padding: '0 2rem',
      minHeight: '100%',
      caretColor: 'var(--foreground)',
    },
    '.cm-focused': {
      outline: 'none',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'inherit',
      lineHeight: '1.6',
    },
    '.cm-line': {
      padding: '0',
    },
    // Placeholder styling
    '.cm-placeholder': {
      color: 'var(--muted-foreground)',
      fontStyle: 'italic',
    },
    // Selection styling - works with drawSelection() extension
    // Focused selection (primary)
    '&.cm-focused .cm-selectionBackground': {
      backgroundColor: 'var(--theme-selection-bg, var(--accent)) !important',
    },
    // Unfocused selection (dimmed)
    '.cm-selectionBackground': {
      backgroundColor: 'var(--theme-selection-bg, var(--accent))',
      opacity: '0.5',
    },
    // Also style native selection as fallback
    '.cm-content ::selection': {
      backgroundColor: 'var(--theme-selection-bg, var(--accent))',
    },
    '.cm-cursor': {
      borderLeftColor: 'var(--foreground)',
      borderLeftWidth: '2px',
    },
    // Gutters (line numbers, etc.)
    '.cm-gutters': {
      backgroundColor: 'transparent',
      borderRight: 'none',
    },
    '.cm-gutter': {
      minWidth: '3rem',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      color: 'var(--muted-foreground)',
      fontSize: '12px',
      padding: '0 0.5rem 0 0',
    },
  })
}

/**
 * Get the initial theme extension wrapped in compartment.
 */
export function getThemeExtension(): Extension {
  return themeCompartment.of(createBaseTheme())
}

/**
 * Reconfigure the theme at runtime.
 */
export function setTheme(view: EditorView, theme: Extension): void {
  view.dispatch({
    effects: themeCompartment.reconfigure(theme),
  })
}
