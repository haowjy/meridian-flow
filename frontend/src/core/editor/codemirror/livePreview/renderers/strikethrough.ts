/**
 * Strikethrough Renderer
 *
 * SOLID: Single Responsibility - Only handles strikethrough formatting
 *
 * Behavior: Word-based (like emphasis)
 * - Shows ~~ when cursor in word
 * - Hides ~~ and adds styling when cursor outside
 */

import { Decoration } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { NodeRenderer, DecorationRange, RenderContext } from '../types'
import { cursorInSameWord } from '../plugin'

// ============================================================================
// DECORATIONS
// ============================================================================

const strikethroughMark = Decoration.mark({ class: 'cm-strikethrough' })

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Find StrikethroughMark children to get marker positions
 */
function findStrikethroughMarkers(node: SyntaxNode): {
  open: { from: number; to: number } | null
  close: { from: number; to: number } | null
} {
  let openMark: { from: number; to: number } | null = null
  let closeMark: { from: number; to: number } | null = null

  const cursor = node.cursor()
  if (cursor.firstChild()) {
    do {
      if (cursor.name === 'StrikethroughMark') {
        if (!openMark) {
          openMark = { from: cursor.from, to: cursor.to }
        } else {
          closeMark = { from: cursor.from, to: cursor.to }
        }
      }
    } while (cursor.nextSibling())
  }

  return { open: openMark, close: closeMark }
}

// ============================================================================
// RENDERER
// ============================================================================

export const strikethroughRenderer: NodeRenderer = {
  nodeTypes: ['Strikethrough'],

  render(node: SyntaxNode, ctx: RenderContext): DecorationRange[] {
    const decorations: DecorationRange[] = []
    const from = node.from
    const to = node.to

    const markers = findStrikethroughMarkers(node)

    // If cursor is in same word, show syntax but still style content
    if (cursorInSameWord(ctx.cursorWords, from, to)) {
      if (markers.open && markers.close && markers.close.from > markers.open.to) {
        decorations.push({
          from: markers.open.to,
          to: markers.close.from,
          deco: strikethroughMark,
        })
      }
      return decorations
    }

    // Hide markers and style content
    if (markers.open && markers.close) {
      // Hide opening marker
      decorations.push({
        from: markers.open.from,
        to: markers.open.to,
        deco: Decoration.replace({}),
      })
      // Hide closing marker
      decorations.push({
        from: markers.close.from,
        to: markers.close.to,
        deco: Decoration.replace({}),
      })
      // Style content between markers
      if (markers.close.from > markers.open.to) {
        decorations.push({
          from: markers.open.to,
          to: markers.close.from,
          deco: strikethroughMark,
        })
      }
    }

    return decorations
  },
}
