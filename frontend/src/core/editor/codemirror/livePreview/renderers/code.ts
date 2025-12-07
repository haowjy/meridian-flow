/**
 * Code Renderer (Inline Code & Code Blocks)
 *
 * SOLID: Single Responsibility - Only handles code formatting
 */

import { Decoration } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { NodeRenderer, DecorationRange, RenderContext } from '../types'
import { cursorInSameWord } from '../plugin'

// ============================================================================
// DECORATIONS
// ============================================================================

const inlineCodeMark = Decoration.mark({ class: 'cm-inline-code' })
const codeBlockLineDeco = Decoration.line({ class: 'cm-code-block' })

// ============================================================================
// INLINE CODE RENDERER
// ============================================================================

export const inlineCodeRenderer: NodeRenderer = {
  nodeTypes: ['InlineCode'],

  render(node: SyntaxNode, ctx: RenderContext): DecorationRange[] {
    const decorations: DecorationRange[] = []
    const { cursorWords } = ctx
    const from = node.from
    const to = node.to

    // If cursor is in same word, show backticks but style content
    if (cursorInSameWord(cursorWords, from, to)) {
      if (to - from > 2) {
        decorations.push({
          from: from + 1,
          to: to - 1,
          deco: inlineCodeMark,
        })
      }
      return decorations
    }

    // Hide the ` markers
    decorations.push({
      from,
      to: from + 1,
      deco: Decoration.replace({}),
    })
    decorations.push({
      from: to - 1,
      to,
      deco: Decoration.replace({}),
    })

    // Style the content
    if (to - from > 2) {
      decorations.push({
        from: from + 1,
        to: to - 1,
        deco: inlineCodeMark,
      })
    }

    return decorations
  },
}

// ============================================================================
// FENCED CODE RENDERER
// ============================================================================

export const fencedCodeRenderer: NodeRenderer = {
  nodeTypes: ['FencedCode'],

  render(node: SyntaxNode, ctx: RenderContext): DecorationRange[] {
    const decorations: DecorationRange[] = []
    const { state } = ctx

    const startLine = state.doc.lineAt(node.from)
    const endLine = state.doc.lineAt(node.to)

    // Add line decoration to each line in the code block
    for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
      const line = state.doc.line(lineNum)
      decorations.push({
        from: line.from,
        to: line.from,
        deco: codeBlockLineDeco,
      })
    }

    return decorations
  },
}
