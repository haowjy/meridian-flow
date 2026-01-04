/**
 * Diff View Extension
 *
 * Provides PUA marker-based diff display for AI suggestions.
 * - Hides PUA markers from display
 * - Styles deletion regions as red strikethrough
 * - Styles insertion regions as green underline
 * - Blocks edits in deletion regions
 * - Accept/reject as CM6 transactions (undoable!)
 * - Focused hunk highlighting and navigation
 *
 * Entry point for diff view functionality.
 */

import type { Extension } from '@codemirror/state'
import { diffViewPlugin } from './plugin'
import { diffEditFilter } from './editFilter'
import { createBlockedEditListener, type BlockedEditCallback } from './blockedEditListener'
import { clipboardExtension } from './clipboard'
import { focusedHunkIndexField } from './focus'
import { hunkHoverPlugin } from './hoverManager'
import { hunkRegionsField } from './hunkRegionsField'

// =============================================================================
// RE-EXPORTS
// =============================================================================

export { diffViewPlugin } from './plugin'
export { diffEditFilter } from './editFilter'
export { blockedEditEffect, type BlockedEditReason } from './blockedEditEffect'
export { createBlockedEditListener, type BlockedEditCallback } from './blockedEditListener'
export { clipboardExtension } from './clipboard'

// Transactions (accept/reject)
export {
  acceptHunk,
  rejectHunk,
  acceptHunkAtPosition,
  rejectHunkAtPosition,
  acceptAll,
  rejectAll,
  getHunks,
} from './transactions'

// Focus state
export { setFocusedHunkIndexEffect, focusedHunkIndexField } from './focus'

// Widget (for advanced use cases)
export { HunkActionWidget } from './HunkActionWidget'

// Hover manager (JS-based hover for multiple hunks per line)
export { hunkHoverPlugin } from './hoverManager'

// Hunk regions (for live preview integration)
export { hunkRegionsField, overlapsHunkRegion, type HunkRegion } from './hunkRegionsField'

// =============================================================================
// TYPES
// =============================================================================

/**
 * Options for the diff view extension bundle.
 */
export interface DiffViewExtensionOptions {
  /** Called when an edit is blocked (for showing toast) */
  onBlockedEdit?: BlockedEditCallback
}

// =============================================================================
// EXTENSION BUNDLE
// =============================================================================

/**
 * Create the diff view extension bundle.
 *
 * OCP: Accepts options for extensibility.
 *
 * @param options - Optional configuration
 * @returns Extension array with view plugin, edit filter, and optional listener
 *
 * @example
 * ```typescript
 * // In EditorPanel, wrap in a Compartment for dynamic reconfiguration
 * const diffCompartment = new Compartment()
 *
 * // Initial: empty
 * extensions: [diffCompartment.of([])]
 *
 * // Enable diff view with feedback:
 * view.dispatch({
 *   effects: diffCompartment.reconfigure(createDiffViewExtension({
 *     onBlockedEdit: (reason) => toast.info('Cannot edit here')
 *   }))
 * })
 * ```
 */
export function createDiffViewExtension(options?: DiffViewExtensionOptions): Extension {
  const extensions: Extension[] = [
    hunkRegionsField, // Must be first - live preview reads this field
    focusedHunkIndexField, // Must be before diffViewPlugin (plugin reads this field)
    diffViewPlugin,
    diffEditFilter,
    clipboardExtension,
    hunkHoverPlugin, // JS-based hover visibility for action buttons
  ]

  if (options?.onBlockedEdit) {
    extensions.push(createBlockedEditListener(options.onBlockedEdit))
  }

  return extensions
}
