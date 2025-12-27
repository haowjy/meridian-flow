/**
 * Edit Filter for Diff View
 *
 * SRP: Only responsible for blocking edits in protected regions.
 *
 * Blocks:
 * 1. Edits that touch marker characters
 * 2. Edits inside DEL regions (read-only original text)
 * 3. Inserts at insStart (breaks DEL_END→INS_START adjacency)
 *
 * Note: Cursor movement is NOT blocked - users can navigate into DEL
 * regions to copy text, they just can't modify it.
 */

import { EditorState } from '@codemirror/state'
import {
  MARKERS,
  extractHunks,
} from '@/features/documents/utils/mergedDocument'
import { blockedEditEffect, type BlockedEditReason } from './blockedEditEffect'

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if text contains any PUA marker character.
 * Used to detect if an edit would modify markers.
 */
function containsAnyMarker(text: string): boolean {
  return (
    text.includes(MARKERS.DEL_START) ||
    text.includes(MARKERS.DEL_END) ||
    text.includes(MARKERS.INS_START) ||
    text.includes(MARKERS.INS_END)
  )
}

// =============================================================================
// TRANSACTION FILTER
// =============================================================================

/**
 * Transaction filter that blocks edits in protected regions.
 *
 * Rules:
 * 1. Pass through non-editing transactions (docChanged === false)
 * 2. Pass through if document has no markers (not in diff mode)
 * 3. Block if edit touches any marker character
 * 4. Block if edit overlaps any DEL region (delStart to delEnd)
 * 5. Block if pure insert at insStart (would break adjacency)
 *
 * Returns [] to cancel the transaction, or tr to allow it.
 *
 * Performance: extractHunks() is O(n) marker scanning, not diffing.
 * For typical documents (<100KB) this is fast enough per-transaction.
 */
export const diffEditFilter = EditorState.transactionFilter.of((tr) => {
  // Pass through non-editing transactions
  if (!tr.docChanged) {
    return tr
  }

  const doc = tr.startState.doc.toString()

  // If no markers at all, nothing to protect (not in diff mode)
  if (!containsAnyMarker(doc)) {
    return tr
  }

  // Extract hunks from the current merged doc.
  // We derive hunks from document content, not from React state.
  const hunks = extractHunks(doc)
  let shouldBlock = false
  let blockReason: BlockedEditReason = 'del_region'

  // Check each change in the transaction
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, _inserted) => {
    // Already determined to block, skip further checks
    if (shouldBlock) return

    const replacedText = doc.slice(fromA, toA)
    const insertedText = _inserted.toString()

    // 1. Block if marker chars are in replaced or inserted text.
    // Markers are hidden visually but still exist in the document.
    if (containsAnyMarker(replacedText) || containsAnyMarker(insertedText)) {
      shouldBlock = true
      blockReason = 'marker_touched'
      return
    }

    // 2. Block edits that overlap deletion regions (original text).
    // Any overlap with the deletion region blocks the edit.
    for (const hunk of hunks) {
      // Check overlap: edit range [fromA, toA) vs DEL region [delStart, delEnd]
      if (fromA <= hunk.delEnd && toA >= hunk.delStart) {
        shouldBlock = true
        blockReason = 'del_region'
        return
      }

      // 3. Block inserts exactly at insStart.
      // DEL_END must be immediately followed by INS_START - inserting text
      // between them would break hunk structure and validateMarkerStructure().
      if (fromA === toA && fromA === hunk.insStart) {
        shouldBlock = true
        blockReason = 'marker_touched'
        return
      }
    }
  })

  // Block if any edit touched a protected region
  // Return transaction with effect (no changes) so listeners can show feedback
  if (shouldBlock) {
    return {
      effects: blockedEditEffect.of({ reason: blockReason }),
    }
  }

  return tr
})
