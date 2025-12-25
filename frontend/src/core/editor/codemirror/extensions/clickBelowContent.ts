/**
 * Click Below Content Extension
 *
 * When clicking in empty space below document content, move cursor to end.
 * This provides a more natural editing experience for small documents.
 */

import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'

export const clickBelowContentExtension = EditorView.domEventHandlers({
  mousedown(event, view) {
    // Check if click is inside the content area but below actual text
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })

    // posAtCoords returns null when clicking outside rendered content
    if (pos === null) {
      // Move cursor to end of document
      const endPos = view.state.doc.length
      view.dispatch({
        selection: EditorSelection.cursor(endPos),
        scrollIntoView: true,
      })
      view.focus()
      return true // Prevent default handling
    }

    return false // Let CM handle normal clicks
  },
})
