import type { EditorView } from "@codemirror/view"
import type { Awareness } from "y-protocols/awareness"

/**
 * Clear only the cursor field from awareness.
 * Preserves the user identity so remote peers don't see a leave/rejoin flash.
 * NEVER call awareness.setLocalState(null) — that emits a removal event.
 */
export function clearCursorAwareness(awareness: Awareness): void {
  awareness.setLocalStateField("cursor", null)
}

/**
 * Force-republish cursor from the current EditorView.
 * yCollab only writes cursor from view.update() when focused — there is no
 * constructor-time publish. Call this after CSS-showing or restoring a view.
 */
export function refreshCursorAwareness(
  awareness: Awareness,
  view: EditorView,
): void {
  void awareness
  const { from, to } = view.state.selection.main
  view.dispatch({ selection: { anchor: from, head: to } })
}
