import {
  ViewPlugin,
  ViewUpdate,
  Decoration,
  DecorationSet,
  EditorView,
} from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import type { Range } from '@codemirror/state'
import { globalRendererRegistry } from './registry'

// Import renderers to trigger registration
import './renderers'

/**
 * Check if cursor position is within a range.
 */
function cursorInRange(cursorPos: number, from: number, to: number): boolean {
  return cursorPos >= from && cursorPos <= to
}

/**
 * Get the current cursor position from the view.
 * Returns the head of the primary selection.
 */
function getCursorPosition(view: EditorView): number {
  return view.state.selection.main.head
}

/**
 * Build decorations for the visible viewport.
 * Only processes nodes that are visible for performance.
 */
function buildDecorations(view: EditorView): DecorationSet {
  const decorations: Range<Decoration>[] = []
  const cursor = getCursorPosition(view)
  const hasFocus = view.hasFocus

  // Get visible ranges for viewport optimization
  const visibleRanges = view.visibleRanges

  for (const { from, to } of visibleRanges) {
    // Iterate through the syntax tree in the visible range
    syntaxTree(view.state).iterate({
      from,
      to,
      enter: (node) => {
        // Check if we have a renderer for this node type
        const renderers = globalRendererRegistry.getRenderers(node.type.name)

        if (renderers.length === 0) {
          return // No renderer for this node type
        }

        // Check if cursor is in this node's range
        // When unfocused, treat all nodes as if cursor is not in range (hide all markdown syntax)
        const isCursorInRange = hasFocus && cursorInRange(cursor, node.from, node.to)

        // Run all renderers for this node
        for (const renderer of renderers) {
          const nodeDecorations = renderer.render(node.node, view, isCursorInRange)
          decorations.push(...nodeDecorations)
        }
      },
    })
  }

  // Sort decorations by position and create DecorationSet
  return Decoration.set(
    decorations.sort((a, b) => a.from - b.from || a.value.startSide - b.value.startSide)
  )
}

/**
 * ViewPlugin for live preview.
 *
 * This plugin:
 * 1. Watches for document changes and selection changes
 * 2. Rebuilds decorations for the visible viewport
 * 3. Uses the renderer registry to process nodes (OCP)
 *
 * Performance notes:
 * - Only processes visible ranges (viewport optimization)
 * - Rebuilds on doc change, selection change, or viewport change
 */
export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }

    update(update: ViewUpdate): void {
      // Rebuild decorations if:
      // - Document changed
      // - Selection changed (cursor moved)
      // - Viewport changed (scrolled)
      // - Focus changed (show/hide all markdown on focus/blur)
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged
      ) {
        this.decorations = buildDecorations(update.view)
      }
    }
  },
  {
    decorations: (v) => v.decorations,
  }
)

/**
 * Get the live preview extension.
 * This is the main entry point for enabling live preview.
 */
export function getLivePreviewExtension(): typeof livePreviewPlugin {
  return livePreviewPlugin
}
