import { Compartment, EditorState } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/**
 * Compartment for editable state.
 * Allows toggling read-only mode at runtime.
 *
 * This follows ISP - editable state is separate from
 * other editor features.
 */
export const editableCompartment = new Compartment()

/**
 * Create the editable extension.
 */
export function createEditableExtension(editable: boolean): Extension {
  return EditorState.readOnly.of(!editable)
}

/**
 * Get the initial editable extension wrapped in compartment.
 */
export function getEditableExtension(editable: boolean = true): Extension {
  return editableCompartment.of(createEditableExtension(editable))
}

/**
 * Set the editable state at runtime.
 */
export function setEditable(view: EditorView, editable: boolean): void {
  view.dispatch({
    effects: editableCompartment.reconfigure(createEditableExtension(editable)),
  })
}
