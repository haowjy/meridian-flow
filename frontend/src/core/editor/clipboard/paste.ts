import { EditorView } from '@codemirror/view'
import { detectContentType } from './detection'
import { htmlToMarkdown } from './conversion'

/**
 * Paste handler extension.
 *
 * SRP: Handle paste event, compose detection + conversion.
 * Converts rich text to markdown, preserves markdown/plain as-is.
 */
export const pasteHandler = EditorView.domEventHandlers({
  paste(event: ClipboardEvent, view: EditorView) {
    const clipboard = event.clipboardData
    if (!clipboard) return false

    const html = clipboard.getData('text/html')
    const text = clipboard.getData('text/plain')

    const contentType = detectContentType(html, text)

    let insert: string

    switch (contentType) {
      case 'rich':
        // Convert rich HTML to markdown
        insert = htmlToMarkdown(html)
        break

      case 'code':
        // Wrap in code block if not already
        if (text && !text.startsWith('```')) {
          insert = '```\n' + text + '\n```'
        } else {
          insert = text || ''
        }
        break

      case 'markdown':
        // Use as-is
        insert = text || ''
        break

      case 'plain':
      default:
        // Use as-is
        insert = text || ''
        break
    }

    if (insert) {
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: { from, to, insert },
        selection: { anchor: from + insert.length },
      })
      event.preventDefault()
      return true
    }

    return false
  },
})
