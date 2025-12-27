/**
 * Blocked Edit Listener
 *
 * SRP: Creates a listener extension for blocked edit effects.
 */

import { EditorView } from '@codemirror/view'
import { blockedEditEffect, type BlockedEditReason } from './blockedEditEffect'

// =============================================================================
// TYPES
// =============================================================================

export type BlockedEditCallback = (reason: BlockedEditReason) => void

// =============================================================================
// LISTENER EXTENSION
// =============================================================================

/**
 * Create an extension that listens for blocked edit effects.
 *
 * @param callback - Called when an edit is blocked
 */
export function createBlockedEditListener(callback: BlockedEditCallback) {
  return EditorView.updateListener.of((update) => {
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(blockedEditEffect)) {
          callback(effect.value.reason)
        }
      }
    }
  })
}
