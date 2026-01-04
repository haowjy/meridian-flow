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
import { RangeSetBuilder } from '@codemirror/state'
import {
  extractHunks,
  type MergedHunk,
} from '@/core/lib/mergedDocument'
import { HunkActionWidget } from './HunkActionWidget'
import { focusedHunkIndexField, setFocusedHunkIndexEffect } from './focus'

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
 * Adds:
 * - 4 replace decorations (hide markers)
 * - 2 mark decorations (style regions)
 * - 1 widget decoration (action buttons)
 * - 1 focus mark if this is the focused hunk
 *
 * @param hunk - The hunk to decorate
 * @param builder - RangeSetBuilder to add decorations to
 * @param view - EditorView for widget callbacks
 * @param hunkIndex - Index of this hunk (for focus comparison)
 * @param focusedIndex - Currently focused hunk index
 */
function createHunkDecorations(
  hunk: MergedHunk,
  builder: RangeSetBuilder<Decoration>,
  view: EditorView,
  hunkIndex: number,
  focusedIndex: number
): void {
  const isFocused = hunkIndex === focusedIndex

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
      Decoration.mark({
        class: 'cm-ai-deletion',
        attributes: { 'data-hunk-id': hunk.id },
      })
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
  // Add focus highlight class if this is the focused hunk
  if (hunk.insertedText.length > 0) {
    const classes = isFocused ? 'cm-ai-insertion cm-ai-hunk-focused' : 'cm-ai-insertion'
    builder.add(
      hunk.insStart + 1, // After INS_START
      hunk.insEnd, // Before INS_END
      Decoration.mark({
        class: classes,
        attributes: { 'data-hunk-id': hunk.id },
      })
    )
  }

  // 6. Hide INS_END marker
  builder.add(
    hunk.insEnd,
    hunk.insEnd + 1,
    Decoration.replace({ widget: markerWidget })
  )

  // 7. Add action widget after the hunk
  builder.add(
    hunk.to,
    hunk.to,
    Decoration.widget({
      widget: new HunkActionWidget(hunk.id, view),
      side: 1, // After the position
    })
  )
}

// =============================================================================
// VIEW PLUGIN
// =============================================================================

/**
 * Viewport buffer for decoration building (in characters).
 *
 * Why 2000: Empirically tuned to cover ~2-3 screen heights of content at
 * typical document widths. This prevents PUA marker characters from briefly
 * appearing during fast scrolling before decorations are rebuilt.
 *
 * Trade-off: Larger buffer = smoother scrolling but more decorations to rebuild.
 * 2000 chars balances scroll smoothness with rebuild performance.
 */
const VIEWPORT_BUFFER = 2000

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
    // - Focused hunk changes (focus styling + widget focused state)
    const hasFocusEffect = update.transactions.some((tr) =>
      tr.effects.some((e) => e.is(setFocusedHunkIndexEffect))
    )
    if (update.docChanged || update.viewportChanged || hasFocusEffect) {
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

    // Read focused hunk index from CM6 state (synced from React store)
    const focusedIndex = view.state.field(focusedHunkIndexField)
    const builder = new RangeSetBuilder<Decoration>()

    // Use extended viewport with buffer to prevent marker flash on scroll
    const viewFrom = Math.max(0, view.viewport.from - VIEWPORT_BUFFER)
    const viewTo = Math.min(doc.length, view.viewport.to + VIEWPORT_BUFFER)

    // Process each hunk (they're already sorted by position from extractHunks)
    hunks.forEach((hunk, index) => {
      // Skip hunks outside extended viewport for performance
      if (hunk.to < viewFrom || hunk.from > viewTo) {
        return
      }

      createHunkDecorations(hunk, builder, view, index, focusedIndex)
    })

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

