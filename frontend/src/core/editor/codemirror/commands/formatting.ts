/**
 * Formatting Commands (Bold, Italic, Code, Heading)
 *
 * SOLID: Single Responsibility - Only handles text formatting
 */

import { EditorSelection } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

// ============================================================================
// WRAP SELECTION HELPERS
// ============================================================================

/**
 * Wrap selection with markers (e.g., ** for bold)
 */
function wrapSelection(view: EditorView, marker: string): boolean {
  const { state } = view
  const { from, to } = state.selection.main
  const selectedText = state.sliceDoc(from, to)

  // Check if already wrapped
  const beforeText = state.sliceDoc(Math.max(0, from - marker.length), from)
  const afterText = state.sliceDoc(to, to + marker.length)

  if (beforeText === marker && afterText === marker) {
    // Remove wrapping
    view.dispatch({
      changes: [
        { from: from - marker.length, to: from },
        { from: to, to: to + marker.length },
      ],
      selection: EditorSelection.range(from - marker.length, to - marker.length),
    })
  } else {
    // Add wrapping
    view.dispatch({
      changes: { from, to, insert: `${marker}${selectedText}${marker}` },
      selection: EditorSelection.range(from + marker.length, to + marker.length),
    })
  }

  return true
}

// ============================================================================
// FORMATTING COMMANDS
// ============================================================================

/**
 * Toggle bold formatting (**text**)
 */
export function toggleBold(view: EditorView): boolean {
  return wrapSelection(view, '**')
}

/**
 * Toggle italic formatting (*text*)
 */
export function toggleItalic(view: EditorView): boolean {
  return wrapSelection(view, '*')
}

/**
 * Toggle inline code formatting (`text`)
 */
export function toggleInlineCode(view: EditorView): boolean {
  return wrapSelection(view, '`')
}

/**
 * Toggle heading at specified level
 */
export function toggleHeading(view: EditorView, level: 1 | 2 | 3): boolean {
  const { state } = view
  const { from } = state.selection.main
  const line = state.doc.lineAt(from)
  const lineText = line.text

  const headingPrefix = '#'.repeat(level) + ' '
  const headingPattern = /^#{1,6}\s/

  if (lineText.startsWith(headingPrefix)) {
    // Remove heading
    view.dispatch({
      changes: { from: line.from, to: line.from + headingPrefix.length },
    })
  } else if (headingPattern.test(lineText)) {
    // Replace existing heading with new level
    const match = lineText.match(headingPattern)
    if (match) {
      view.dispatch({
        changes: { from: line.from, to: line.from + match[0].length, insert: headingPrefix },
      })
    }
  } else {
    // Add heading
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: headingPrefix },
    })
  }

  return true
}

/**
 * Insert a link at cursor position
 */
export function insertLink(view: EditorView, url: string, text?: string): boolean {
  const { state } = view
  const { from, to } = state.selection.main
  const selectedText = state.sliceDoc(from, to)
  const linkText = text || selectedText || 'link'
  const markdown = `[${linkText}](${url})`

  view.dispatch({
    changes: { from, to, insert: markdown },
    selection: EditorSelection.cursor(from + markdown.length),
  })

  return true
}
