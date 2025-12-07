import { Decoration } from '@codemirror/view'
import type { Range } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { MarkdownRenderer } from '../types'
import { CLASSES, hideDecoration, markDecoration } from '../decorations'

/**
 * Renderer for emphasis (bold, italic, bold+italic).
 *
 * Handles:
 * - *italic* or _italic_
 * - **bold** or __bold__
 * - ***bold italic*** or ___bold italic___
 *
 * When cursor is NOT in the emphasis:
 * - Hide the * or _ markers
 * - Style the content with bold/italic
 *
 * When cursor IS in the emphasis:
 * - Show the markers (dimmed)
 * - Still style the content
 */
export const emphasisRenderer: MarkdownRenderer = {
  nodeTypes: ['Emphasis', 'StrongEmphasis'],

  render(
    node: SyntaxNode,
    view: EditorView,
    cursorInRange: boolean
  ): Range<Decoration>[] {
    const decorations: Range<Decoration>[] = []
    const doc = view.state.doc
    const nodeText = doc.sliceString(node.from, node.to)

    // Determine the type of emphasis
    const isStrong = node.type.name === 'StrongEmphasis'
    const markerLength = isStrong ? 2 : 1

    // Check if this is actually bold+italic (*** or ___)
    const isBoldItalic = nodeText.startsWith('***') || nodeText.startsWith('___')

    // Get the appropriate style class
    let styleClass: string
    if (isBoldItalic) {
      styleClass = CLASSES.boldItalic
    } else if (isStrong) {
      styleClass = CLASSES.bold
    } else {
      styleClass = CLASSES.italic
    }

    // Find EmphasisMark children (the * or _ markers)
    const marks: SyntaxNode[] = []
    let child = node.firstChild
    while (child) {
      if (child.type.name === 'EmphasisMark') {
        marks.push(child)
      }
      child = child.nextSibling
    }

    // Hide markers when cursor is not in the emphasis
    if (!cursorInRange && marks.length >= 2) {
      const firstMark = marks[0]
      const lastMark = marks[marks.length - 1]
      if (firstMark && lastMark) {
        // Hide opening marker
        decorations.push(hideDecoration(firstMark.from, firstMark.to))
        // Hide closing marker
        decorations.push(hideDecoration(lastMark.from, lastMark.to))
      }
    }

    // Style the content (between the markers)
    if (marks.length >= 2) {
      const firstMark = marks[0]
      const lastMark = marks[marks.length - 1]
      if (firstMark && lastMark) {
        const contentFrom = firstMark.to
        const contentTo = lastMark.from
        if (contentFrom < contentTo) {
          decorations.push(markDecoration(contentFrom, contentTo, styleClass))
        }
      }
    } else {
      // Fallback: style the whole node content (minus markers)
      const contentFrom = node.from + markerLength
      const contentTo = node.to - markerLength
      if (contentFrom < contentTo) {
        decorations.push(markDecoration(contentFrom, contentTo, styleClass))
      }
    }

    return decorations
  },
}
