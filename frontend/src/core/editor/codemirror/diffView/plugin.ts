/**
 * Diff View Plugin
 *
 * SOLID: Single Responsibility - Each component handles one concern:
 * - MarkerWidget: renders zero-width placeholders
 * - createHunkDecorations: builds decorations for one hunk
 * - DiffViewPluginClass: manages decoration lifecycle
 *
 * Creates decorations to:
 * 1. Always hide PUA marker characters (replace with zero-width spans)
 * 2. Style deletion + insertion regions
 */

import {
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import {
  extractHunks,
  type MergedHunk,
} from '@/features/documents/utils/mergedDocument'

// =============================================================================
// MARKER HIDING WIDGET
// =============================================================================

/**
 * Zero-width widget that replaces PUA markers.
 * The marker is still in the document, but this widget has no visual width.
 *
 * LSP: Extends WidgetType following CM6 contract.
 */
class MarkerWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-pua-marker'
    return span
  }

  eq(): boolean {
    return true // All marker widgets are equivalent
  }
}

// Singleton instance - all markers use the same widget
const markerWidget = new MarkerWidget()

// =============================================================================
// DECORATION BUILDERS
// =============================================================================

/**
 * Create decorations for a single hunk.
 *
 * SRP: Only responsible for building decorations for one hunk.
 * Adds 4 replace decorations (hide markers) + 2 mark decorations (style regions).
 *
 * @param hunk - The hunk to decorate
 * @param builder - RangeSetBuilder to add decorations to
 */
function createHunkDecorations(
  hunk: MergedHunk,
  builder: RangeSetBuilder<Decoration>
): void {
  // 1. Hide DEL_START marker
  builder.add(
    hunk.delStart,
    hunk.delStart + 1,
    Decoration.replace({ widget: markerWidget })
  )

  // 2. Style deletion content (if any)
  if (hunk.deletedText.length > 0) {
    builder.add(
      hunk.delStart + 1, // After DEL_START
      hunk.delEnd, // Before DEL_END
      Decoration.mark({ class: 'cm-ai-deletion' })
    )
  }

  // 3. Hide DEL_END marker
  builder.add(
    hunk.delEnd,
    hunk.delEnd + 1,
    Decoration.replace({ widget: markerWidget })
  )

  // 4. Hide INS_START marker
  builder.add(
    hunk.insStart,
    hunk.insStart + 1,
    Decoration.replace({ widget: markerWidget })
  )

  // 5. Style insertion content (if any)
  if (hunk.insertedText.length > 0) {
    builder.add(
      hunk.insStart + 1, // After INS_START
      hunk.insEnd, // Before INS_END
      Decoration.mark({ class: 'cm-ai-insertion' })
    )
  }

  // 6. Hide INS_END marker
  builder.add(
    hunk.insEnd,
    hunk.insEnd + 1,
    Decoration.replace({ widget: markerWidget })
  )
}

// =============================================================================
// VIEW PLUGIN
// =============================================================================

/**
 * Viewport buffer for decoration building.
 * Prevents marker flash during fast scrolling by decorating beyond visible area.
 */
const VIEWPORT_BUFFER = 2000 // characters

/**
 * ViewPlugin implementation for diff view decorations.
 *
 * SRP: Only responsible for managing decoration lifecycle.
 * DIP: Depends on MergedHunk abstraction from Phase 1.
 */
class DiffViewPluginClass {
  decorations: DecorationSet

  constructor(view: EditorView) {
    this.decorations = this.buildDecorations(view)
  }

  update(update: ViewUpdate) {
    // Rebuild decorations when:
    // - Document changes (hunk positions shift)
    // - Viewport changes (scrolling can reveal un-decorated markers)
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.buildDecorations(update.view)
    }
  }

  /**
   * Build decorations for all hunks in the viewport.
   *
   * Uses viewport culling with buffer for performance.
   * Always extracts fresh hunks to ensure positions are accurate after edits.
   */
  buildDecorations(view: EditorView): DecorationSet {
    const doc = view.state.doc.toString()
    const hunks = extractHunks(doc)

    if (hunks.length === 0) {
      return Decoration.none
    }

    const builder = new RangeSetBuilder<Decoration>()

    // Use extended viewport with buffer to prevent marker flash on scroll
    const viewFrom = Math.max(0, view.viewport.from - VIEWPORT_BUFFER)
    const viewTo = Math.min(doc.length, view.viewport.to + VIEWPORT_BUFFER)

    // Process each hunk (they're already sorted by position from extractHunks)
    for (const hunk of hunks) {
      // Skip hunks outside extended viewport for performance
      if (hunk.to < viewFrom || hunk.from > viewTo) {
        continue
      }

      createHunkDecorations(hunk, builder)
    }

    return builder.finish()
  }

  destroy() {
    // No cleanup needed - decorations are managed by CM6
  }
}

/**
 * The diff view ViewPlugin.
 *
 * Note: We don't need EditorView.atomicRanges because Decoration.replace
 * widgets already prevent the cursor from landing on replaced content.
 */
export const diffViewPlugin = ViewPlugin.fromClass(DiffViewPluginClass, {
  decorations: (v) => v.decorations,
})

// =============================================================================
// EXTENSION BUNDLE
// =============================================================================

/**
 * Create the diff view extension bundle.
 *
 * OCP: Signature designed for future extension with keymap callbacks (Phase 5).
 *
 * @returns Extension array with view plugin
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
    // Edit filter added in Phase 3
    // Keymap with callbacks added in Phase 5
  ]
}
