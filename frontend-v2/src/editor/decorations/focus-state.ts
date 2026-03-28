import { StateEffect, StateField, type Extension } from "@codemirror/state"
import { EditorView } from "@codemirror/view"

import { revealState } from "./reveal-state"

/**
 * Effect dispatched to update the focus state of the editor.
 * true = focused, false = blurred.
 */
export const focusChange = StateEffect.define<boolean>()

/**
 * StateField tracking whether the editor is focused.
 * StateFields can't access `view.hasFocus` directly, so this field
 * mirrors DOM focus state via effects dispatched by `focusTracker`.
 */
export const focusState = StateField.define<boolean>({
  create: () => false,
  update(focused, tr) {
    for (const effect of tr.effects) {
      if (effect.is(focusChange)) return effect.value
    }
    return focused
  },
})

/**
 * DOM event handlers that dispatch focusChange effects to keep focusState
 * in sync with actual DOM focus. Blur is debounced by 50ms to prevent
 * flash when context menus temporarily steal focus.
 */
function createFocusTracker(): Extension {
  let blurTimeout: ReturnType<typeof setTimeout> | null = null

  return EditorView.domEventHandlers({
    focus(_event, view) {
      if (blurTimeout) {
        clearTimeout(blurTimeout)
        blurTimeout = null
        // Cancel pending blur -- focus never actually left, no dispatch needed
        return false
      }
      view.dispatch({ effects: focusChange.of(true) })
      return false // let CM6 handle focus normally
    },
    blur(_event, view) {
      // Skip blur dispatch if a reveal is active -- the user may be
      // interacting with a context menu on a revealed element
      try {
        if (view.state.field(revealState).size > 0) return false
      } catch {
        // revealState field not in state -- skip guard
      }

      blurTimeout = setTimeout(() => {
        blurTimeout = null
        view.dispatch({ effects: focusChange.of(false) })
      }, 50)
      return false
    },
  })
}

/**
 * Extension that provides the focusTracker DOM event handlers.
 * Must be included in the editor's extension stack alongside focusState.
 */
export const focusTracker: Extension = createFocusTracker()
