/**
 * Link Renderer
 *
 * SOLID: Single Responsibility - Only handles links
 */

import { Decoration } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { NodeRenderer, DecorationRange, RenderContext } from '../types'
import { cursorInSameWord } from '../plugin'

// ============================================================================
// DECORATIONS
// ============================================================================

const linkMark = Decoration.mark({ class: 'cm-link' })

// ============================================================================
// RENDERER
// ============================================================================

export const linkRenderer: NodeRenderer = {
  nodeTypes: ['Link'],

  render(node: SyntaxNode, ctx: RenderContext): DecorationRange[] {
    const decorations: DecorationRange[] = []
    const { state, cursorWords } = ctx
    const from = node.from
    const to = node.to

    // If cursor is in same word, show all syntax
    if (cursorInSameWord(cursorWords, from, to)) {
      return decorations
    }

    const text = state.doc.sliceString(from, to)
    const closeBracketIdx = text.indexOf('](')

    if (closeBracketIdx === -1) {
      return decorations
    }

    const textStart = from + 1
    const textEnd = from + closeBracketIdx
    const urlPartStart = from + closeBracketIdx
    const urlPartEnd = to

    // Hide the opening [
    decorations.push({
      from,
      to: from + 1,
      deco: Decoration.replace({}),
    })

    // Style the link text
    if (textEnd > textStart) {
      decorations.push({
        from: textStart,
        to: textEnd,
        deco: linkMark,
      })
    }

    // Hide ](url)
    decorations.push({
      from: urlPartStart,
      to: urlPartEnd,
      deco: Decoration.replace({}),
    })

    return decorations
  },
}
