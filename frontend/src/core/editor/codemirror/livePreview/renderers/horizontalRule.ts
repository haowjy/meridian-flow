/**
 * Horizontal Rule Renderer
 *
 * SOLID: Single Responsibility - Only handles horizontal rule formatting
 *
 * Behavior: Line-based
 * - Shows --- when cursor on line
 * - Replaces with styled <hr> widget when cursor outside
 */

import { Decoration, WidgetType } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { NodeRenderer, DecorationRange, RenderContext } from '../types'
import { selectionOverlapsRange } from '../plugin'

// ============================================================================
// WIDGET
// ============================================================================

/**
 * Widget for horizontal rule - displays a styled <hr> element
 */
class HorizontalRuleWidget extends WidgetType {
  toDOM(): HTMLElement {
    const hr = document.createElement('div')
    hr.className = 'cm-hr-widget'
    return hr
  }
}

// ============================================================================
// RENDERER
// ============================================================================

export const horizontalRuleRenderer: NodeRenderer = {
  nodeTypes: ['HorizontalRule'],

  render(node: SyntaxNode, ctx: RenderContext): DecorationRange[] {
    const decorations: DecorationRange[] = []
    const { state } = ctx

    const line = state.doc.lineAt(node.from)

    // Don't replace if cursor is on this line
    if (selectionOverlapsRange(state, line.from, line.to + 1)) {
      return decorations
    }

    // Replace entire line content with hr widget
    decorations.push({
      from: node.from,
      to: node.to,
      deco: Decoration.replace({ widget: new HorizontalRuleWidget() }),
    })

    return decorations
  },
}
