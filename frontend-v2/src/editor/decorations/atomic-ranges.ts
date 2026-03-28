import type { EditorState } from "@codemirror/state"
import type { DecorationSet, EditorView } from "@codemirror/view"

import { blockDecorationField } from "./block-decorations"

/**
 * Returns atomic widget decoration ranges from the block StateField.
 * Only includes .md-widget-wrapper replace decorations.
 * Links (.md-link) are mark decorations and are never included.
 * HR (.md-hr-wrapper) uses a distinct class and is excluded.
 *
 * This is the ONLY input that should be passed to nearestWidgetAtPos.
 */
export function getAtomicWidgetRanges(view: EditorView): DecorationSet {
  return view.state.field(blockDecorationField)
}

/**
 * Returns the atomic widget decoration adjacent to `pos`, or null.
 * Only matches atomic replace decorations with class .md-widget-wrapper.
 * Links (.md-link) are mark decorations and are never returned.
 * HR (.md-hr-wrapper) is excluded by the class filter.
 */
export function nearestWidgetAtPos(
  _state: EditorState,
  pos: number,
  decos: DecorationSet,
): { from: number; to: number } | null {
  // Check if pos is inside a decoration range
  const cursor = decos.iter()
  while (cursor.value) {
    if (pos >= cursor.from && pos <= cursor.to) {
      return { from: cursor.from, to: cursor.to }
    }
    cursor.next()
  }

  // Check adjacent positions -- the cursor may be resting at a boundary
  const boundaryCursor = decos.iter()
  while (boundaryCursor.value) {
    if (boundaryCursor.to === pos || boundaryCursor.from === pos) {
      return { from: boundaryCursor.from, to: boundaryCursor.to }
    }
    boundaryCursor.next()
  }

  return null
}
