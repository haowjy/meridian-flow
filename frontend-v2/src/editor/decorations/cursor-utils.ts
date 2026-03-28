import type { EditorState } from "@codemirror/state"
import type { EditorView } from "@codemirror/view"

function rangesIntersect(fromA: number, toA: number, fromB: number, toB: number): boolean {
  return fromA <= toB && fromB <= toA
}

/**
 * Track whether the editor has ever received a real user interaction.
 * Before the first interaction, everything should preview (cursor at 0 is
 * a default, not a user choice). WeakMap prevents memory leaks on unmount.
 */
const hasInteracted = new WeakMap<EditorView, boolean>()

/** Mark this editor as having received user interaction. */
export function markInteracted(view: EditorView): void {
  hasInteracted.set(view, true)
}

/**
 * Returns true if the cursor intersects [from - padding, to + padding] AND the
 * editor is focused with a real user-placed cursor. Returns false when:
 * - Editor is not focused (everything should preview)
 * - Editor has never been interacted with (cursor at 0 is just the default)
 *
 * The padding (default 1) handles the "immediately adjacent" case so that
 * placing the cursor right before or after a formatted region reveals its
 * raw markdown syntax — matching Obsidian's behavior.
 */
export function cursorInRange(view: EditorView, from: number, to: number, padding = 1): boolean {
  if (!view.hasFocus || !hasInteracted.get(view)) {
    return false
  }

  const paddedFrom = from - padding
  const paddedTo = to + padding

  for (const range of view.state.selection.ranges) {
    if (range.empty) {
      if (range.from >= paddedFrom && range.from <= paddedTo) {
        return true
      }
      continue
    }

    if (rangesIntersect(range.from, range.to, paddedFrom, paddedTo)) {
      return true
    }
  }

  return false
}

/**
 * Returns true if the selection intersects [from - padding, to + padding].
 * Unlike cursorInRange, this takes EditorState (not EditorView) so it can
 * be used from StateField update functions that don't have view access.
 *
 * Does NOT check focus or interaction state -- callers must handle those
 * guards separately (e.g., via focusState StateField).
 */
export function selectionIntersectsRange(
  state: EditorState,
  from: number,
  to: number,
  padding = 0,
): boolean {
  const paddedFrom = from - padding
  const paddedTo = to + padding

  for (const range of state.selection.ranges) {
    if (range.empty) {
      if (range.from >= paddedFrom && range.from <= paddedTo) {
        return true
      }
      continue
    }

    if (rangesIntersect(range.from, range.to, paddedFrom, paddedTo)) {
      return true
    }
  }

  return false
}

/**
 * Returns true if the cursor is on the given line number AND the editor
 * is focused with a real user-placed cursor.
 */
export function cursorOnLine(view: EditorView, lineNumber: number): boolean {
  if (!view.hasFocus || !hasInteracted.get(view)) {
    return false
  }

  const line = view.state.doc.line(lineNumber)

  for (const range of view.state.selection.ranges) {
    if (range.empty) {
      if (range.from >= line.from && range.from <= line.to) {
        return true
      }
      continue
    }

    if (rangesIntersect(range.from, range.to, line.from, line.to)) {
      return true
    }
  }

  return false
}
