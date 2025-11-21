import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'

/**
 * ClickHandler Extension
 *
 * This extension adds a ProseMirror plugin that intercepts clicks on the editor container.
 * If the user clicks in "empty space" (where there is no direct node), ProseMirror
 * normally does nothing. This plugin calculates the nearest valid cursor position
 * and moves the cursor there, ensuring the editor feels "alive" everywhere.
 */
export const ClickHandler = Extension.create({
  name: 'clickHandler',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('clickHandler'),
        props: {
          handleClick: (view: EditorView, pos: number, event: MouseEvent) => {
            // If the click was directly on a node (pos is valid and inside content),
            // let ProseMirror handle it normally.
            // However, we want to catch clicks that might be "outside" but still in the container.
            // The `handleClick` prop is called for clicks *inside* the editable element.
            // If we want to handle clicks on the *container* (padding area), we might need
            // to attach a listener to the editor element itself or rely on how ProseMirror
            // handles clicks.

            // Actually, Tiptap/ProseMirror's `handleClick` fires when clicking inside the
            // .ProseMirror element. Since we made .ProseMirror min-h-full, it covers
            // the whole area.
            
            // If the click target is the editor content div itself (not a paragraph/text node),
            // it means the user clicked in the "gap" or "padding" area.
            // We want to focus the editor and place the cursor at the clicked position.
            
            if (event.target === view.dom) {
              // The click hit the main editor element, not a specific node.
              // We calculate the position from coordinates.
              const posAtCoords = view.posAtCoords({
                left: event.clientX,
                top: event.clientY,
              })

              if (posAtCoords) {
                const { pos, inside } = posAtCoords
                
                // If we clicked "after" the last node, posAtCoords might return the position
                // inside the last node or at the end.
                // We want to move the cursor there.
                
                const tr = view.state.tr.setSelection(
                  Selection.near(view.state.doc.resolve(pos))
                )
                view.dispatch(tr)
                view.focus()
                return true // Handled
              }
            }

            return false // Let ProseMirror handle other clicks
          },
        },
      }),
    ]
  },
})
