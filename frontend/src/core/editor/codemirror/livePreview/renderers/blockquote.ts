/**
 * Blockquote Renderer
 *
 * SOLID: Single Responsibility - Only handles blockquote formatting
 *
 * Behavior: Line-based (like headings)
 * - Shows > when cursor on line
 * - Hides > and adds styling when cursor outside
 */

import { Decoration } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { NodeRenderer, DecorationRange, RenderContext } from '../types'
import { selectionOverlapsRange } from '../plugin'

// ============================================================================
// DECORATIONS
// ============================================================================

const blockquoteLineDeco = Decoration.line({ class: 'cm-blockquote' })

// ============================================================================
// RENDERER
// ============================================================================

export const blockquoteRenderer: NodeRenderer = {
  nodeTypes: ['Blockquote'],

  render(node: SyntaxNode, ctx: RenderContext): DecorationRange[] {
    const decorations: DecorationRange[] = []
    const { state } = ctx

    // Blockquotes can span multiple lines, process each line
    const startLine = state.doc.lineAt(node.from)
    const endLine = state.doc.lineAt(node.to)

    for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
      const line = state.doc.line(lineNum)

      // Add line decoration for blockquote styling
      decorations.push({
        from: line.from,
        to: line.from,
        deco: blockquoteLineDeco,
      })

      // Don't hide syntax if cursor is on this line
      if (selectionOverlapsRange(state, line.from, line.to + 1)) {
        continue
      }

      // Find and hide the > marker at the start of the line
      const lineText = line.text
      const match = lineText.match(/^(\s*>\s?)/)
      if (match) {
        decorations.push({
          from: line.from,
          to: line.from + match[0].length,
          deco: Decoration.replace({}),
        })
      }
    }

    return decorations
  },
}
