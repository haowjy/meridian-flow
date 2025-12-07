/**
 * Heading Renderer
 *
 * SOLID: Single Responsibility - Only handles headings
 */

import { Decoration } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { NodeRenderer, DecorationRange, RenderContext } from '../types'
import { selectionOverlapsRange, getLineRange } from '../plugin'

// ============================================================================
// DECORATIONS
// ============================================================================

const headingLineDecos = {
  1: Decoration.line({ class: 'cm-heading cm-heading-1' }),
  2: Decoration.line({ class: 'cm-heading cm-heading-2' }),
  3: Decoration.line({ class: 'cm-heading cm-heading-3' }),
}

// ============================================================================
// HEADING PROCESSOR
// ============================================================================

function processHeading(
  node: SyntaxNode,
  level: 1 | 2 | 3,
  ctx: RenderContext
): DecorationRange[] {
  const decorations: DecorationRange[] = []
  const { state } = ctx
  const from = node.from
  const to = node.to
  const line = state.doc.lineAt(from)

  // Add line decoration for heading styling
  decorations.push({
    from: line.from,
    to: line.from,
    deco: headingLineDecos[level],
  })

  // Don't hide syntax if cursor is on this line
  const lineRange = getLineRange(state, from)
  if (selectionOverlapsRange(state, lineRange.from, lineRange.to + 1)) {
    return decorations
  }

  // Find the HeaderMark child (the # symbols)
  let headerMarkEnd = from
  const cursor = node.cursor()
  if (cursor.firstChild()) {
    do {
      if (cursor.name === 'HeaderMark') {
        headerMarkEnd = cursor.to
        break
      }
    } while (cursor.nextSibling())
  }

  if (headerMarkEnd > from) {
    // Hide the # symbols and the space after
    const hideEnd = Math.min(headerMarkEnd + 1, to)
    decorations.push({
      from,
      to: hideEnd,
      deco: Decoration.replace({}),
    })
  }

  return decorations
}

// ============================================================================
// RENDERERS
// ============================================================================

export const heading1Renderer: NodeRenderer = {
  nodeTypes: ['ATXHeading1'],
  render(node, ctx) {
    return processHeading(node, 1, ctx)
  },
}

export const heading2Renderer: NodeRenderer = {
  nodeTypes: ['ATXHeading2'],
  render(node, ctx) {
    return processHeading(node, 2, ctx)
  },
}

export const heading3Renderer: NodeRenderer = {
  nodeTypes: ['ATXHeading3'],
  render(node, ctx) {
    return processHeading(node, 3, ctx)
  },
}
