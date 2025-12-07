import { Decoration } from '@codemirror/view'
import type { Range } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { MarkdownRenderer } from '../types'
import { CLASSES, hideDecoration } from '../decorations'

/**
 * Get the heading class for a given level.
 */
function getHeadingClass(level: number): string {
  const classes: Record<number, string> = {
    1: CLASSES.heading1,
    2: CLASSES.heading2,
    3: CLASSES.heading3,
    4: CLASSES.heading4,
    5: CLASSES.heading5,
    6: CLASSES.heading6,
  }
  return classes[level] || CLASSES.heading6
}

/**
 * Extract heading level from node type (e.g., 'ATXHeading1' -> 1).
 */
function getHeadingLevel(nodeType: string): number {
  const match = nodeType.match(/ATXHeading(\d)/)
  return match && match[1] ? parseInt(match[1], 10) : 1
}

/**
 * Renderer for ATX-style headings (# Heading).
 *
 * When cursor is NOT in the heading:
 * - Hide the # markers
 * - Style the heading text with appropriate size
 *
 * When cursor IS in the heading:
 * - Show the # markers
 * - Still style the text (slightly dimmer markers)
 */
export const headingRenderer: MarkdownRenderer = {
  nodeTypes: [
    'ATXHeading1',
    'ATXHeading2',
    'ATXHeading3',
    'ATXHeading4',
    'ATXHeading5',
    'ATXHeading6',
  ],

  render(
    node: SyntaxNode,
    view: EditorView,
    cursorInRange: boolean
  ): Range<Decoration>[] {
    const decorations: Range<Decoration>[] = []
    const level = getHeadingLevel(node.type.name)
    const headingClass = getHeadingClass(level)

    // Find the HeaderMark child (the # symbols)
    let headerMark = node.firstChild
    while (headerMark && headerMark.type.name !== 'HeaderMark') {
      headerMark = headerMark.nextSibling
    }

    if (headerMark) {
      // If cursor is not in the heading, hide the # markers
      if (!cursorInRange) {
        // Hide the # and the space after it
        const markEnd = headerMark.to
        // Find where the actual content starts (after space)
        const contentStart = Math.min(markEnd + 1, node.to)
        decorations.push(hideDecoration(headerMark.from, contentStart))
      }
    }

    // Style the entire heading line
    // Get the line containing the heading
    const line = view.state.doc.lineAt(node.from)
    decorations.push(
      Decoration.line({
        class: headingClass,
      }).range(line.from)
    )

    return decorations
  },
}
