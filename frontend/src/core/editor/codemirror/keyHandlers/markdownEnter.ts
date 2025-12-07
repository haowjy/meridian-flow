/**
 * Markdown Enter Key Handler
 *
 * SOLID:
 * - Single Responsibility: Only handles Enter key behavior
 * - Open/Closed: Uses handler registry for extensibility
 *
 * Provides smart list/blockquote continuation and exit behavior.
 */

import { EditorSelection } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { insertNewline } from '@codemirror/commands'

// ============================================================================
// HANDLER INTERFACE (OCP: extensible)
// ============================================================================

interface LineHandler {
  pattern: RegExp
  /**
   * Handle the Enter key for this pattern
   * @returns true if handled, false to try next handler
   */
  handle(
    view: EditorView,
    match: RegExpExecArray,
    line: { from: number; to: number; text: string }
  ): boolean
}

// ============================================================================
// EXIT HELPER
// ============================================================================

/**
 * Exit a markdown markup line (list/quote)
 * Replaces the line with just indentation, then inserts newline
 */
function exitMarkdownMarkupLine(
  view: EditorView,
  line: { from: number; to: number },
  indent: string
): boolean {
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: indent },
    selection: EditorSelection.cursor(line.from + indent.length),
  })
  return insertNewline(view)
}

// ============================================================================
// HANDLERS
// ============================================================================

const bulletHandler: LineHandler = {
  pattern: /^(\s*)([*+-])\s*(.*)$/,

  handle(view, match, line) {
    const indent = match[1] ?? ''
    const marker = match[2] ?? '-'
    const rest = match[3] ?? ''

    // Empty item: exit the list
    if (rest.trim().length === 0) {
      return exitMarkdownMarkupLine(view, line, indent)
    }

    // Non-empty: continue the list
    const insertText = '\n' + indent + marker + ' '
    const insertPos = line.to
    const cursorPos = insertPos + insertText.length

    view.dispatch({
      changes: { from: insertPos, to: insertPos, insert: insertText },
      selection: EditorSelection.cursor(cursorPos),
    })
    return true
  },
}

const orderedHandler: LineHandler = {
  pattern: /^(\s*)(\d+)([.)])\s*(.*)$/,

  handle(view, match, line) {
    const indent = match[1] ?? ''
    const numStr = match[2] ?? '1'
    const delim = match[3] ?? '.'
    const rest = match[4] ?? ''

    // Empty item: exit the list
    if (rest.trim().length === 0) {
      return exitMarkdownMarkupLine(view, line, indent)
    }

    // Non-empty: continue with next number
    const nextNum = String(parseInt(numStr, 10) + 1)
    const markerText = nextNum + delim
    const insertText = '\n' + indent + markerText + ' '
    const insertPos = line.to
    const cursorPos = insertPos + insertText.length

    view.dispatch({
      changes: { from: insertPos, to: insertPos, insert: insertText },
      selection: EditorSelection.cursor(cursorPos),
    })
    return true
  },
}

const blockquoteHandler: LineHandler = {
  pattern: /^(\s*)>(\s*)(.*)$/,

  handle(view, match, line) {
    const indent = match[1] ?? ''
    const space = match[2] ?? ' '
    const rest = match[3] ?? ''
    const markerText = '>' + (space || ' ')

    // Empty quote line: exit the blockquote
    if (rest.trim().length === 0) {
      return exitMarkdownMarkupLine(view, line, indent)
    }

    // Non-empty: continue the quote
    const insertText = '\n' + indent + markerText
    const insertPos = line.to
    const cursorPos = insertPos + insertText.length

    view.dispatch({
      changes: { from: insertPos, to: insertPos, insert: insertText },
      selection: EditorSelection.cursor(cursorPos),
    })
    return true
  },
}

// Handler registry (OCP: add new handlers here)
const handlers: LineHandler[] = [bulletHandler, orderedHandler, blockquoteHandler]

// ============================================================================
// MAIN COMMAND
// ============================================================================

/**
 * Smart Enter key handler for markdown
 */
export function markdownEnter(view: EditorView): boolean {
  const { state } = view
  const { main } = state.selection

  // Only handle simple cursor (no selection)
  if (!main.empty) {
    return false
  }

  const line = state.doc.lineAt(main.head)
  const cursorOffset = main.head - line.from
  const lineText = line.text

  // If cursor is before end of text, do normal split
  if (cursorOffset < lineText.trimEnd().length) {
    return insertNewline(view)
  }

  // Try each handler
  for (const handler of handlers) {
    const match = handler.pattern.exec(lineText)
    if (match) {
      return handler.handle(view, match, {
        from: line.from,
        to: line.to,
        text: lineText,
      })
    }
  }

  // Fallback: normal newline
  return insertNewline(view)
}

// ============================================================================
// KEYMAP EXTENSION
// ============================================================================

export const markdownEnterKeymap = keymap.of([
  { key: 'Enter', run: markdownEnter },
])
