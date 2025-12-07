/**
 * Auto-Closing Pairs Handler
 *
 * SOLID:
 * - Single Responsibility: Only handles auto-pairing behavior
 * - Dependency Inversion: Uses StateField instead of global state
 *
 * Provides ghost bracket behavior:
 * - First `(`: inserts `(|)` with ghost closing paren
 * - Second `(`: consumes ghost, creates `((|))`
 * - Typing other content: ghost becomes real
 */

import { EditorSelection, Prec } from '@codemirror/state'
import { keymap, type EditorView } from '@codemirror/view'
import { ghostField, getGhost, type GhostState, setGhostEffect } from '../state'

// ============================================================================
// BRACKET PAIRS
// ============================================================================

const BRACKETS: Record<string, string> = {
  '[': ']',
  '(': ')',
  '{': '}',
}

const ALL_PAIRS: Record<string, string> = {
  ...BRACKETS,
  '`': '`',
}

// ============================================================================
// DISPATCH HELPER
// ============================================================================

/**
 * Dispatch with ghost state update
 */
function dispatchWithGhost(
  view: EditorView,
  changes: { from: number; to: number; insert: string },
  cursorPos: number,
  ghost: GhostState | null
): void {
  view.dispatch({
    changes,
    selection: EditorSelection.cursor(cursorPos),
    effects: setGhostEffect.of(ghost),
  })
}

// ============================================================================
// BACKTICK HANDLER
// ============================================================================

const backtickHandler = keymap.of([
  {
    key: '`',
    run: (view) => {
      const { from, to } = view.state.selection.main
      const ghost = getGhost(view.state)

      // Check what's before cursor
      const before = view.state.sliceDoc(Math.max(0, from - 2), from)

      // Case 1: Third backtick → create code block
      if (before === '``') {
        dispatchWithGhost(
          view,
          { from, to, insert: '`\n\n```' },
          from + 2,
          null
        )
        return true
      }

      // Case 2: Cursor at ghost backtick → consume it
      if (ghost && ghost.pos === from && ghost.chars === '`') {
        const afterCursor = view.state.sliceDoc(from, from + 1)
        if (afterCursor === '`') {
          dispatchWithGhost(
            view,
            { from, to: from + 1, insert: '`' },
            from + 1,
            null
          )
          return true
        }
      }

      // Case 3: First backtick → insert with ghost
      dispatchWithGhost(
        view,
        { from, to, insert: '``' },
        from + 1,
        { pos: from + 1, chars: '`' }
      )
      return true
    },
  },
])

// ============================================================================
// BRACKET HANDLERS
// ============================================================================

function createOpenBracketHandler(open: string, close: string) {
  return {
    key: open,
    run: (view: EditorView) => {
      const { from, to } = view.state.selection.main
      const ghost = getGhost(view.state)

      // Case 1: Second open when ghost is single close → double up
      if (ghost && ghost.pos === from && ghost.chars === close) {
        const afterCursor = view.state.sliceDoc(from, from + 1)
        if (afterCursor === close) {
          dispatchWithGhost(
            view,
            { from, to: from + 1, insert: open + close + close },
            from + 1,
            { pos: from + 1, chars: close + close }
          )
          return true
        }
      }

      // Case 2: First open → insert with ghost close
      dispatchWithGhost(
        view,
        { from, to, insert: open + close },
        from + 1,
        { pos: from + 1, chars: close }
      )
      return true
    },
  }
}

function createCloseBracketHandler(close: string) {
  return {
    key: close,
    run: (view: EditorView) => {
      const { from } = view.state.selection.main
      const ghost = getGhost(view.state)

      // If ghost starts with this close char, skip over it
      if (ghost && ghost.pos === from && ghost.chars.startsWith(close)) {
        const afterCursor = view.state.sliceDoc(from, from + 1)
        if (afterCursor === close) {
          // Move cursor, update ghost
          const newGhost =
            ghost.chars.length > 1
              ? { pos: from + 1, chars: ghost.chars.slice(1) }
              : null

          view.dispatch({
            selection: EditorSelection.cursor(from + 1),
            effects: setGhostEffect.of(newGhost),
          })
          return true
        }
      }

      // Let default behavior handle it
      return false
    },
  }
}

const bracketHandler = keymap.of([
  // Opening brackets
  ...Object.entries(BRACKETS).map(([open, close]) =>
    createOpenBracketHandler(open, close)
  ),
  // Closing brackets
  ...Object.values(BRACKETS).map(close => createCloseBracketHandler(close)),
])

// ============================================================================
// DELETE EMPTY PAIR
// ============================================================================

function deleteEmptyPair(view: EditorView): boolean {
  const { from } = view.state.selection.main
  if (from === 0) return false

  const charBefore = view.state.sliceDoc(from - 1, from)
  const charAfter = view.state.sliceDoc(from, from + 1)
  const expectedClose = ALL_PAIRS[charBefore]

  // If between matching pair, delete one pair
  if (expectedClose && charAfter === expectedClose) {
    view.dispatch({
      changes: { from: from - 1, to: from + 1 },
      selection: EditorSelection.cursor(from - 1),
      effects: setGhostEffect.of(null),
    })
    return true
  }

  return false
}

const deleteEmptyPairKeymap = keymap.of([
  { key: 'Backspace', run: deleteEmptyPair },
])

// ============================================================================
// COMBINED EXTENSION
// ============================================================================

/**
 * Auto-closing pairs extension with ghost behavior
 *
 * Includes:
 * - Ghost state field
 * - Backtick handler (single/double/triple)
 * - Bracket handlers
 * - Delete empty pair
 */
export const autoPairsExtension = [
  ghostField,
  Prec.high(backtickHandler),
  Prec.high(bracketHandler),
  Prec.high(deleteEmptyPairKeymap),
]
