/**
 * Blocked Edit Effect
 *
 * SRP: Defines the StateEffect for blocked edit notifications.
 * Pattern follows ghostState.ts StateEffect conventions.
 */

import { StateEffect } from '@codemirror/state'

// =============================================================================
// TYPES
// =============================================================================

/** Reason why an edit was blocked. */
export type BlockedEditReason = 'del_region' | 'marker_touched'

// =============================================================================
// STATE EFFECT
// =============================================================================

/**
 * Effect dispatched when an edit is blocked in a protected region.
 * Listeners can show user feedback (toast, shake, etc.)
 */
export const blockedEditEffect = StateEffect.define<{
  reason: BlockedEditReason
}>()
