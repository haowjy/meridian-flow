/**
 * Live Preview Types
 *
 * SOLID: Open/Closed - NodeRenderer interface allows extension without modification
 */

import type { Decoration } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

// ============================================================================
// RENDER CONTEXT
// ============================================================================

/**
 * Context passed to renderers for decoration building
 */
export interface RenderContext {
  /** Current editor state */
  state: EditorState
  /** Pre-computed cursor word bounds for performance */
  cursorWords: Array<{ from: number; to: number }>
}

// ============================================================================
// DECORATION RANGE
// ============================================================================

/**
 * A decoration with its position range
 */
export interface DecorationRange {
  from: number
  to: number
  deco: Decoration
}

// ============================================================================
// NODE RENDERER INTERFACE (OCP: Open for Extension)
// ============================================================================

/**
 * Interface for node renderers
 *
 * Implement this to add new node type support without modifying the plugin.
 */
export interface NodeRenderer {
  /** Node types this renderer handles (e.g., ['StrongEmphasis', 'Emphasis']) */
  nodeTypes: string[]

  /**
   * Render decorations for a node
   *
   * @param node - The syntax tree node to render
   * @param ctx - Render context with state and cursor info
   * @returns Array of decorations to apply
   */
  render(node: SyntaxNode, ctx: RenderContext): DecorationRange[]
}
