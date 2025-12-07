import { Decoration } from '@codemirror/view'
import type { Range } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { MarkdownRenderer } from '../types'
import { CLASSES, hideDecoration, markDecoration, lineDecoration } from '../decorations'

/**
 * Renderer for inline code `code`.
 *
 * When cursor is NOT in the code:
 * - Hide the backticks
 * - Style with code background
 *
 * When cursor IS in the code:
 * - Show backticks (dimmed)
 * - Still style with code background
 */
export const inlineCodeRenderer: MarkdownRenderer = {
  nodeTypes: ['InlineCode'],

  render(
    node: SyntaxNode,
    view: EditorView,
    cursorInRange: boolean
  ): Range<Decoration>[] {
    const decorations: Range<Decoration>[] = []
    const doc = view.state.doc
    const nodeText = doc.sliceString(node.from, node.to)

    // Determine backtick count (can be ` or ``)
    let backtickCount = 0
    for (const char of nodeText) {
      if (char === '`') backtickCount++
      else break
    }

    // Verify closing backticks match
    const expectedEnd = '`'.repeat(backtickCount)
    if (!nodeText.endsWith(expectedEnd)) {
      // Malformed, skip
      return decorations
    }

    const contentFrom = node.from + backtickCount
    const contentTo = node.to - backtickCount

    if (!cursorInRange) {
      // Hide backticks
      decorations.push(hideDecoration(node.from, contentFrom))
      decorations.push(hideDecoration(contentTo, node.to))
    }

    // Style the code content (or whole thing if cursor is in)
    if (cursorInRange) {
      // Style whole thing including backticks when editing
      decorations.push(markDecoration(node.from, node.to, CLASSES.inlineCode))
    } else {
      // Style just the content
      decorations.push(markDecoration(contentFrom, contentTo, CLASSES.inlineCode))
    }

    return decorations
  },
}

/**
 * Renderer for fenced code blocks.
 *
 * ```language
 * code
 * ```
 *
 * Styles the entire block with code styling.
 * The language is preserved for syntax highlighting.
 */
export const codeBlockRenderer: MarkdownRenderer = {
  nodeTypes: ['FencedCode'],

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  render(node: SyntaxNode, view: EditorView, cursorInRange: boolean): Range<Decoration>[] {
    const decorations: Range<Decoration>[] = []
    const doc = view.state.doc

    // Get all lines in the code block
    const startLine = doc.lineAt(node.from)
    const endLine = doc.lineAt(node.to)

    // Add line decoration to each line
    for (let lineNum = startLine.number; lineNum <= endLine.number; lineNum++) {
      const line = doc.line(lineNum)
      decorations.push(lineDecoration(line.from, CLASSES.codeBlock))
    }

    return decorations
  },
}
