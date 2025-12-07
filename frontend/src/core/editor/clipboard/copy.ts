import { EditorView } from '@codemirror/view'
import { markdownToHtml } from './conversion'

/**
 * Copy handler extension.
 *
 * SRP: Handle copy/cut events.
 * Copies both plain text (markdown) and HTML for rich paste targets.
 */
export const copyHandler = EditorView.domEventHandlers({
  copy(event: ClipboardEvent, view: EditorView) {
    const clipboard = event.clipboardData
    if (!clipboard) return false

    const { from, to } = view.state.selection.main
    if (from === to) return false // No selection

    const text = view.state.sliceDoc(from, to)
    const html = markdownToHtml(text)

    clipboard.setData('text/plain', text)
    clipboard.setData('text/html', html)

    event.preventDefault()
    return true
  },

  cut(event: ClipboardEvent, view: EditorView) {
    const clipboard = event.clipboardData
    if (!clipboard) return false

    const { from, to } = view.state.selection.main
    if (from === to) return false // No selection

    const text = view.state.sliceDoc(from, to)
    const html = markdownToHtml(text)

    clipboard.setData('text/plain', text)
    clipboard.setData('text/html', html)

    // Delete the selection
    view.dispatch({
      changes: { from, to, insert: '' },
      selection: { anchor: from },
    })

    event.preventDefault()
    return true
  },
})
