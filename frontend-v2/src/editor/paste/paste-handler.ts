import type { Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

import { yjsOrigin, ORIGIN_HUMAN } from "../annotations"
import { containsMeaningfulMarkup, htmlToMarkdown } from "./html-to-markdown"

/**
 * Paste handler extension for the editor.
 * Wired into pasteHandlerCompartment in Editor.tsx.
 *
 * When pasting HTML content:
 * 1. Check if clipboard contains text/html
 * 2. Check if the HTML has meaningful markup (not just meta wrappers)
 * 3. Convert to markdown via turndown + DOMPurify sanitization
 * 4. Insert the markdown at the cursor position
 *
 * Plain text paste falls through to CM6's default handler.
 * Image paste inserts a placeholder (full upload integration depends on backend).
 */
export function pasteHandler(): Extension {
  return EditorView.domEventHandlers({
    paste(event: ClipboardEvent, view: EditorView) {
      const clipboardData = event.clipboardData
      if (!clipboardData) return false

      // Check for pasted images first
      const files = clipboardData.files
      if (files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i]
          if (file.type.startsWith("image/")) {
            event.preventDefault()
            const { from, to } = view.state.selection.main
            // Placeholder until backend image upload is available
            const placeholder = `![pasted image](TODO: upload)`
            view.dispatch({
              changes: { from, to, insert: placeholder },
              selection: { anchor: from + placeholder.length },
              annotations: [yjsOrigin.of(ORIGIN_HUMAN)],
            })
            return true
          }
        }
      }

      // Check for HTML content
      const html = clipboardData.getData("text/html")

      if (html && containsMeaningfulMarkup(html)) {
        event.preventDefault()
        const markdown = htmlToMarkdown(html)
        const { from, to } = view.state.selection.main
        view.dispatch({
          changes: { from, to, insert: markdown },
          selection: { anchor: from + markdown.length },
          annotations: [yjsOrigin.of(ORIGIN_HUMAN)],
        })
        return true
      }

      // Plain text paste: let CM6 handle it normally
      return false
    },
  })
}
