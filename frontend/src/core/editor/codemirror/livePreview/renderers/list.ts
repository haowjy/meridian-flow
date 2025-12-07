/**
 * List Renderer (Bullets & Ordered Lists)
 *
 * SOLID: Single Responsibility - Only handles list formatting
 *
 * NEW: This was not in the old implementation - ported from test editor
 */

import { Decoration, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { NodeRenderer, DecorationRange, RenderContext } from '../types'
import { selectionOverlapsRange } from '../plugin'

// ============================================================================
// WIDGETS
// ============================================================================

/**
 * Widget for bullet list markers - displays "•"
 */
class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-list-bullet-widget'
    span.textContent = '•'
    return span
  }
}

/**
 * Widget for ordered list markers - displays the actual number (e.g., "1.", "2.")
 */
class NumberWidget extends WidgetType {
  constructor(readonly num: string) {
    super()
  }

  eq(other: NumberWidget): boolean {
    return this.num === other.num
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-list-number-widget'
    span.textContent = this.num
    return span
  }
}

// ============================================================================
// RENDERER
// ============================================================================

export const listItemRenderer: NodeRenderer = {
  nodeTypes: ['ListItem'],

  render(node: SyntaxNode, ctx: RenderContext): DecorationRange[] {
    const decorations: DecorationRange[] = []
    const { state } = ctx

    const line = state.doc.lineAt(node.from)
    const parent = node.parent
    const isOrdered = parent?.name === 'OrderedList'

    // Find ListMark child
    const cursor = node.cursor()
    if (!cursor.firstChild()) return decorations

    do {
      if (cursor.name === 'ListMark') {
        // Use line-based detection (like headings) - show raw syntax when cursor on line
        if (selectionOverlapsRange(state, line.from, line.to + 1)) {
          return decorations
        }

        // Get the marker text (e.g., "-", "*", "1.", "2.")
        const markerText = state.doc.sliceString(cursor.from, cursor.to)

        // Create appropriate widget
        const widget = isOrdered ? new NumberWidget(markerText) : new BulletWidget()

        // Replace marker + trailing space with widget
        const hideEnd = Math.min(cursor.to + 1, line.to)
        decorations.push({
          from: cursor.from,
          to: hideEnd,
          deco: Decoration.replace({ widget }),
        })
        break
      }
    } while (cursor.nextSibling())

    return decorations
  },
}
