/**
 * Table Renderer
 *
 * SOLID: Single Responsibility - Only handles table formatting
 *
 * Behavior: Line-based (Obsidian-style)
 * - Shows raw syntax when cursor in table
 * - Hides delimiter row and adds styling when cursor outside
 */

import { Decoration } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { NodeRenderer, DecorationRange, RenderContext } from '../types'
import { selectionOverlapsRange } from '../plugin'

// ============================================================================
// DECORATIONS
// ============================================================================

const tableLineDeco = Decoration.line({ class: 'cm-table-row' })
const tableHeaderLineDeco = Decoration.line({ class: 'cm-table-row cm-table-header' })

// ============================================================================
// RENDERER
// ============================================================================

export const tableRenderer: NodeRenderer = {
  nodeTypes: ['Table'],

  render(node: SyntaxNode, ctx: RenderContext): DecorationRange[] {
    const decorations: DecorationRange[] = []
    const { state } = ctx

    // If cursor is anywhere in the table, show raw syntax
    if (selectionOverlapsRange(state, node.from, node.to + 1)) {
      return decorations
    }

    // Process table children: TableHeader, TableDelimiter, TableRow
    const cursor = node.cursor()
    if (!cursor.firstChild()) return decorations

    do {
      const childNode = cursor.node
      const line = state.doc.lineAt(childNode.from)

      switch (cursor.name) {
        case 'TableHeader':
          // Add header styling
          decorations.push({
            from: line.from,
            to: line.from,
            deco: tableHeaderLineDeco,
          })
          break

        case 'TableDelimiter':
          // Hide the delimiter row (|---|---|)
          decorations.push({
            from: childNode.from,
            to: childNode.to,
            deco: Decoration.replace({}),
          })
          break

        case 'TableRow':
          // Add row styling
          decorations.push({
            from: line.from,
            to: line.from,
            deco: tableLineDeco,
          })
          break
      }
    } while (cursor.nextSibling())

    return decorations
  },
}
