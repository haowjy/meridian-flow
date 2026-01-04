/**
 * Accept/Reject Transaction Helpers
 *
 * SRP: Only handles CM6 transaction dispatch for hunk operations.
 * All operations use filter:false + userEvent annotation for undo support.
 *
 * Key insight: These are CM6 transactions, so Cmd+Z undoes them!
 */

import type { EditorView } from '@codemirror/view'
import { Transaction } from '@codemirror/state'
import {
  extractHunks,
  getAcceptReplacement,
  getRejectReplacement,
  acceptAllHunks,
  rejectAllHunks,
  type MergedHunk,
} from '@/core/lib/mergedDocument'
import { makeLogger } from '@/core/lib/logger'

const logger = makeLogger('diff-transactions')

// =============================================================================
// SINGLE HUNK OPERATIONS
// =============================================================================

/**
 * Accept a single hunk by ID.
 *
 * Replaces the entire hunk (markers + content) with the insertion text.
 * Returns true if the hunk was found and accepted.
 */
export function acceptHunk(view: EditorView, hunkId: string): boolean {
  const doc = view.state.doc.toString()
  const hunks = extractHunks(doc)
  const hunk = hunks.find((h) => h.id === hunkId)

  if (!hunk) {
    logger.warn(`Hunk not found: ${hunkId}`)
    return false
  }

  const replacement = getAcceptReplacement(hunk)

  view.dispatch({
    changes: { from: hunk.from, to: hunk.to, insert: replacement },
    // Bypass transaction filters - we intentionally delete/replace marker ranges
    filter: false,
    annotations: Transaction.userEvent.of('ai.diff.accept'),
  })

  logger.debug(`Accepted hunk ${hunkId}`)
  return true
}

/**
 * Reject a single hunk by ID.
 *
 * Replaces the entire hunk (markers + content) with the deletion text.
 * Returns true if the hunk was found and rejected.
 */
export function rejectHunk(view: EditorView, hunkId: string): boolean {
  const doc = view.state.doc.toString()
  const hunks = extractHunks(doc)
  const hunk = hunks.find((h) => h.id === hunkId)

  if (!hunk) {
    logger.warn(`Hunk not found: ${hunkId}`)
    return false
  }

  const replacement = getRejectReplacement(hunk)

  view.dispatch({
    changes: { from: hunk.from, to: hunk.to, insert: replacement },
    filter: false,
    annotations: Transaction.userEvent.of('ai.diff.reject'),
  })

  logger.debug(`Rejected hunk ${hunkId}`)
  return true
}

// =============================================================================
// POSITION-BASED OPERATIONS (for keyboard shortcuts)
// =============================================================================

/**
 * Accept the hunk at a given document position.
 *
 * Used for keyboard shortcut (accept hunk at cursor).
 */
export function acceptHunkAtPosition(view: EditorView, pos: number): boolean {
  const doc = view.state.doc.toString()
  const hunks = extractHunks(doc)
  const hunk = hunks.find((h) => pos >= h.from && pos <= h.to)

  if (!hunk) return false

  return acceptHunk(view, hunk.id)
}

/**
 * Reject the hunk at a given document position.
 *
 * Used for keyboard shortcut (reject hunk at cursor).
 */
export function rejectHunkAtPosition(view: EditorView, pos: number): boolean {
  const doc = view.state.doc.toString()
  const hunks = extractHunks(doc)
  const hunk = hunks.find((h) => pos >= h.from && pos <= h.to)

  if (!hunk) return false

  return rejectHunk(view, hunk.id)
}

// =============================================================================
// BULK OPERATIONS
// =============================================================================

/**
 * Accept all hunks.
 *
 * Replaces the entire document with the AI version (all insertions kept).
 */
export function acceptAll(view: EditorView): void {
  const doc = view.state.doc.toString()
  const accepted = acceptAllHunks(doc)

  view.dispatch({
    changes: { from: 0, to: doc.length, insert: accepted },
    filter: false,
    annotations: Transaction.userEvent.of('ai.diff.acceptAll'),
  })

  logger.debug('Accepted all hunks')
}

/**
 * Reject all hunks.
 *
 * Replaces the entire document with the original version (all deletions kept).
 */
export function rejectAll(view: EditorView): void {
  const doc = view.state.doc.toString()
  const rejected = rejectAllHunks(doc)

  view.dispatch({
    changes: { from: 0, to: doc.length, insert: rejected },
    filter: false,
    annotations: Transaction.userEvent.of('ai.diff.rejectAll'),
  })

  logger.debug('Rejected all hunks')
}

// =============================================================================
// CONVENIENCE GETTER
// =============================================================================

/**
 * Get hunks from the current document.
 *
 * Convenience function for UI components.
 */
export function getHunks(view: EditorView): MergedHunk[] {
  return extractHunks(view.state.doc.toString())
}
