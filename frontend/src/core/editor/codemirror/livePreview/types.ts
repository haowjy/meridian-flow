import type { DecorationSet, Decoration, EditorView } from '@codemirror/view'
import type { Range } from '@codemirror/state'
import type { SyntaxNode } from '@lezer/common'

/**
 * A renderer for a specific markdown element type.
 * Follows OCP - new renderers can be added without modifying the plugin.
 */
export interface MarkdownRenderer {
  /** The node types this renderer handles (e.g., 'ATXHeading1', 'Emphasis') */
  nodeTypes: string[]

  /**
   * Create decorations for the given node.
   * @param node - The syntax tree node
   * @param view - The editor view
   * @param cursorInRange - Whether the cursor is within this node's range
   * @returns Array of decoration ranges, or empty array to skip
   */
  render(
    node: SyntaxNode,
    view: EditorView,
    cursorInRange: boolean
  ): Range<Decoration>[]
}

/**
 * Configuration for the live preview plugin.
 */
export interface LivePreviewConfig {
  /** Whether to hide syntax when cursor is not on element */
  hideInactiveSyntax: boolean
  /** Whether links are clickable */
  clickableLinks: boolean
}

/**
 * State tracked by the live preview plugin.
 */
export interface LivePreviewState {
  /** Current decorations */
  decorations: DecorationSet
}
