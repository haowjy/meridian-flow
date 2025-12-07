import { Decoration, WidgetType } from '@codemirror/view'
import type { Range } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import type { MarkdownRenderer } from '../types'
import { CLASSES, hideDecoration, markDecoration } from '../decorations'

/**
 * Widget to display a link icon after the link text.
 * Shown when cursor is not in the link to indicate it's clickable.
 */
class LinkIconWidget extends WidgetType {
  constructor(private url: string) {
    super()
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-md-link-icon'
    span.textContent = ' ↗'
    span.title = this.url
    return span
  }

  eq(other: LinkIconWidget): boolean {
    return this.url === other.url
  }
}

/**
 * Renderer for links [text](url).
 *
 * When cursor is NOT in the link:
 * - Hide [, ], (, url, )
 * - Show just the link text with underline
 * - Add a small link icon
 *
 * When cursor IS in the link:
 * - Show full markdown syntax
 * - Still style the text part
 */
export const linkRenderer: MarkdownRenderer = {
  nodeTypes: ['Link'],

  render(
    node: SyntaxNode,
    view: EditorView,
    cursorInRange: boolean
  ): Range<Decoration>[] {
    const decorations: Range<Decoration>[] = []
    const doc = view.state.doc

    // Find the link components
    // Link structure: [ LinkMark? LinkLabel LinkMark? ] ( URL )
    let linkLabel: SyntaxNode | null = null
    let url: SyntaxNode | null = null
    let openBracket: { from: number; to: number } | null = null
    let closeBracket: { from: number; to: number } | null = null
    let openParen: { from: number; to: number } | null = null
    let closeParen: { from: number; to: number } | null = null

    let child = node.firstChild
    while (child) {
      if (child.type.name === 'LinkMark') {
        const text = doc.sliceString(child.from, child.to)
        if (text === '[') {
          openBracket = { from: child.from, to: child.to }
        } else if (text === ']') {
          closeBracket = { from: child.from, to: child.to }
        } else if (text === '(') {
          openParen = { from: child.from, to: child.to }
        } else if (text === ')') {
          closeParen = { from: child.from, to: child.to }
        }
      } else if (child.type.name === 'LinkLabel') {
        linkLabel = child
      } else if (child.type.name === 'URL') {
        url = child
      }
      child = child.nextSibling
    }

    if (!linkLabel) return decorations

    const urlText = url ? doc.sliceString(url.from, url.to) : ''

    if (!cursorInRange) {
      // Hide all syntax except the link text
      if (openBracket) {
        decorations.push(hideDecoration(openBracket.from, openBracket.to))
      }
      if (closeBracket && openParen && closeParen) {
        // Hide from ] to end of )
        decorations.push(hideDecoration(closeBracket.from, closeParen.to))
      }

      // Style the link text
      decorations.push(markDecoration(linkLabel.from, linkLabel.to, CLASSES.link))

      // Add link icon widget after the label
      if (urlText) {
        decorations.push(
          Decoration.widget({
            widget: new LinkIconWidget(urlText),
            side: 1,
          }).range(linkLabel.to)
        )
      }
    } else {
      // Cursor in link - show syntax but still style the text
      decorations.push(markDecoration(linkLabel.from, linkLabel.to, CLASSES.link))

      // Dim the URL
      if (url) {
        decorations.push(markDecoration(url.from, url.to, CLASSES.linkUrl))
      }
    }

    return decorations
  },
}
