/**
 * Emphasis Renderer (Bold & Italic)
 *
 * SOLID: Single Responsibility - Only handles emphasis formatting
 */

import { Decoration } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { NodeRenderer, DecorationRange, RenderContext } from '../types'
import { cursorInSameWord } from '../plugin'

// ============================================================================
// DECORATIONS
// ============================================================================

const boldMark = Decoration.mark({ class: 'cm-strong' })
const italicMark = Decoration.mark({ class: 'cm-em' })

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Find EmphasisMark children to get actual marker positions
 * Handles nested emphasis like ***text*** correctly
 */
function findEmphasisMarkers(node: SyntaxNode): {
  open: { from: number; to: number } | null
  close: { from: number; to: number } | null
} {
  let openMark: { from: number; to: number } | null = null
  let closeMark: { from: number; to: number } | null = null

  const cursor = node.cursor()
  if (cursor.firstChild()) {
    do {
      if (cursor.name === 'EmphasisMark') {
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

/**
 * Process emphasis nodes (bold or italic)
 * Generic handler - same logic, different decoration
 */
function processEmphasisNode(
  node: SyntaxNode,
  ctx: RenderContext,
  markDecoration: Decoration
): DecorationRange[] {
  const decorations: DecorationRange[] = []
  const from = node.from
  const to = node.to

  const markers = findEmphasisMarkers(node)

  // If cursor is in same word, show syntax but still style content
  if (cursorInSameWord(ctx.cursorWords, from, to)) {
    if (markers.open && markers.close && markers.close.from > markers.open.to) {
      decorations.push({
        from: markers.open.to,
        to: markers.close.from,
        deco: markDecoration,
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
        deco: markDecoration,
      })
    }
  }

  return decorations
}

// ============================================================================
// RENDERERS
// ============================================================================

export const boldRenderer: NodeRenderer = {
  nodeTypes: ['StrongEmphasis'],
  render(node, ctx) {
    return processEmphasisNode(node, ctx, boldMark)
  },
}

export const italicRenderer: NodeRenderer = {
  nodeTypes: ['Emphasis'],
  render(node, ctx) {
    return processEmphasisNode(node, ctx, italicMark)
  },
}
