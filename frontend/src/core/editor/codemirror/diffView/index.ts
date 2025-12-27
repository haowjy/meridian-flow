/**
 * Diff View Extension
 *
 * Provides PUA marker-based diff display for AI suggestions.
 * - Hides PUA markers from display
 * - Styles deletion regions as red strikethrough
 * - Styles insertion regions as green underline
 * - Blocks edits in deletion regions
 *
 * Entry point for diff view functionality.
 */

import type { Extension } from '@codemirror/state'
import { diffViewPlugin } from './plugin'
import { diffEditFilter } from './editFilter'

// =============================================================================
// RE-EXPORTS
// =============================================================================

export { diffViewPlugin } from './plugin'
export { diffEditFilter } from './editFilter'

// =============================================================================
// EXTENSION BUNDLE
// =============================================================================

/**
 * Create the diff view extension bundle.
 *
 * OCP: Designed for future extension with options (Phase 3a adds onBlockedEdit).
 *
 * @returns Extension array with view plugin and edit filter
 *
 * @example
 * ```typescript
 * // In EditorPanel, wrap in a Compartment for dynamic reconfiguration
 * const diffCompartment = new Compartment()
 *
 * // Initial: empty
 * extensions: [diffCompartment.of([])]
 *
 * // Enable diff view:
 * view.dispatch({
 *   effects: diffCompartment.reconfigure(createDiffViewExtension())
 * })
 * ```
 */
export function createDiffViewExtension(): Extension {
  return [
    diffViewPlugin,
    diffEditFilter,
    // Keymap with callbacks added in Phase 5
  ]
}
