/**
 * Ghost State Management
 *
 * SOLID: Dependency Inversion - Uses StateField instead of global mutable state
 *
 * The "ghost" is a provisional closing character (like `)` after typing `(`).
 * If the user types the same opening char again, the ghost is consumed.
 * If the user types other content, the ghost becomes real.
 */

import { StateField, StateEffect, type EditorState, type Transaction } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

// ============================================================================
// TYPES
// ============================================================================

export interface GhostState {
  /** Position where ghost starts (cursor position) */
  pos: number
  /** The ghost characters (e.g., "`", "]", "]]") */
  chars: string
}

// ============================================================================
// STATE EFFECTS
// ============================================================================

/** Set ghost state */
export const setGhostEffect = StateEffect.define<GhostState | null>()

/** Clear ghost state (when document changes from non-handler input) */
export const clearGhostEffect = StateEffect.define<void>()

// ============================================================================
// STATE FIELD
// ============================================================================

/**
 * StateField for ghost state - replaces global `let ghost`
 */
export const ghostField = StateField.define<GhostState | null>({
  create() {
    return null
  },

  update(value, tr: Transaction) {
    // Check for explicit set/clear effects
    for (const effect of tr.effects) {
      if (effect.is(setGhostEffect)) {
        return effect.value
      }
      if (effect.is(clearGhostEffect)) {
        return null
      }
    }

    // If document changed without our effects, clear ghost
    // (user typed something other than our handler)
    if (tr.docChanged && !tr.effects.some(e => e.is(setGhostEffect))) {
      // Check if any of our effects are present (handler dispatch)
      const hasHandlerEffect = tr.effects.some(
        e => e.is(setGhostEffect) || e.is(clearGhostEffect)
      )
      if (!hasHandlerEffect) {
        return null
      }
    }

    // Adjust position if document changed
    if (value && tr.docChanged) {
      const newPos = tr.changes.mapPos(value.pos)
      return { ...value, pos: newPos }
    }

    return value
  },
})

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get current ghost state from editor state
 */
export function getGhost(state: EditorState): GhostState | null {
  return state.field(ghostField)
}

/**
 * Set ghost state via transaction
 */
export function setGhost(view: EditorView, ghost: GhostState | null): void {
  view.dispatch({
    effects: setGhostEffect.of(ghost),
  })
}

/**
 * Clear ghost state via transaction
 */
export function clearGhost(view: EditorView): void {
  view.dispatch({
    effects: clearGhostEffect.of(undefined),
  })
}

/**
 * Dispatch a transaction with ghost state update
 * Use this when making changes that should set/update ghost
 */
export function dispatchWithGhost(
  view: EditorView,
  changes: Parameters<EditorView['dispatch']>[0],
  ghost: GhostState | null
): void {
  const ghostEffect = ghost ? setGhostEffect.of(ghost) : clearGhostEffect.of(undefined)

  // Handle effects which can be a single effect or an array
  const existingEffects = changes.effects
    ? Array.isArray(changes.effects)
      ? changes.effects
      : [changes.effects]
    : []

  view.dispatch({
    ...changes,
    effects: [...existingEffects, ghostEffect],
  })
}
