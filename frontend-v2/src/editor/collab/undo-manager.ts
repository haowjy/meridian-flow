/**
 * Y.UndoManager factory with tracked-origin policy.
 *
 * Always Yjs-native: Y.UndoManager is the single undo source of truth.
 * CM6 history is never used. No compartment swap mechanism.
 *
 * trackedOrigins includes ORIGIN_HUMAN, ORIGIN_ACCEPT, ORIGIN_REJECT, ORIGIN_THREAD.
 * null origin (remote sync) is explicitly excluded -- tracking null would make
 * remote changes undoable, breaking collaborative undo semantics.
 */

import * as Y from "yjs"

import {
  ORIGIN_ACCEPT,
  ORIGIN_HUMAN,
  ORIGIN_REJECT,
  ORIGIN_THREAD,
} from "../annotations"

// Re-export origin constants for consumer convenience
export { ORIGIN_ACCEPT, ORIGIN_HUMAN, ORIGIN_REJECT, ORIGIN_THREAD }

/**
 * Create a Y.UndoManager scoped to text content and proposal status metadata.
 *
 * trackedOrigins includes ORIGIN_HUMAN, ORIGIN_ACCEPT, ORIGIN_REJECT, ORIGIN_THREAD.
 * null origin (remote sync) is explicitly excluded -- tracking null would make
 * remote changes undoable, breaking collaborative undo semantics.
 *
 * CRITICAL: Call `undoManager.stopCapturing()` before each discrete action
 * (accept, reject, thread op) to ensure it gets its own undo step. Without this,
 * accepting a hunk and then immediately typing would merge into one undo step.
 */
export function createYUndoManager(ydoc: Y.Doc): Y.UndoManager {
  const ytext = ydoc.getText("content")
  const yProposalStatus = ydoc.getMap("_proposal_status")

  return new Y.UndoManager([ytext, yProposalStatus], {
    trackedOrigins: new Set([
      ORIGIN_HUMAN, // user typing, formatting shortcuts, paste
      ORIGIN_ACCEPT, // accepting a proposal
      ORIGIN_REJECT, // rejecting a proposal
      ORIGIN_THREAD, // thread-related edits
    ]),
    // null is intentionally excluded -- sync providers use null as origin.
    // Never add null or the sync provider instance to trackedOrigins.
  })
}
