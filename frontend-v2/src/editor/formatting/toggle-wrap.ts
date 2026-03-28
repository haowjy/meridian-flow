import { syntaxTree } from "@codemirror/language"
import type { EditorView } from "@codemirror/view"

import { ORIGIN_HUMAN, yjsOrigin } from "../annotations"

/**
 * Expected syntax tree node type for each marker string.
 * Used to validate that adjacent markers belong to the same formatting span.
 */
function expectedNodeType(marker: string): string | null {
  switch (marker) {
    case "**":
      return "StrongEmphasis"
    case "*":
      return "Emphasis"
    case "`":
      return "InlineCode"
    case "~~":
      return "Strikethrough"
    default:
      return null
  }
}

/**
 * Toggle wrap/unwrap formatting around the current selection.
 *
 * Syntax-tree-validated unwrap: before removing markers, verifies that the
 * adjacent markers belong to the SAME formatting span. Without this check,
 * `**bold** and **more**` with "and" selected would incorrectly detect
 * the closing ** of "bold" and opening ** of "more" as a wrapping pair,
 * destroying both spans.
 *
 * All dispatches include yjsOrigin.of(ORIGIN_HUMAN) for Y.UndoManager tracking.
 */
export function toggleWrap(view: EditorView, marker: string): boolean {
  const { from, to } = view.state.selection.main
  const selectedText = view.state.sliceDoc(from, to)
  const expected = expectedNodeType(marker)

  // Check if already wrapped -- validate via syntax tree
  const before = view.state.sliceDoc(
    Math.max(0, from - marker.length),
    from,
  )
  const after = view.state.sliceDoc(to, to + marker.length)

  if (before === marker && after === marker && expected) {
    const tree = syntaxTree(view.state)
    const nodeAtFrom = tree.resolveInner(from, -1)
    const nodeAtTo = tree.resolveInner(to, 1)

    // Walk up from both sides to find the containing formatting node
    const parentLeft =
      nodeAtFrom.type.name === expected
        ? nodeAtFrom
        : nodeAtFrom.parent?.type.name === expected
          ? nodeAtFrom.parent
          : null
    const parentRight =
      nodeAtTo.type.name === expected
        ? nodeAtTo
        : nodeAtTo.parent?.type.name === expected
          ? nodeAtTo.parent
          : null

    // Only unwrap if both markers belong to the same formatting span
    if (parentLeft && parentRight && parentLeft.from === parentRight.from) {
      view.dispatch({
        changes: [
          { from: from - marker.length, to: from },
          { from: to, to: to + marker.length },
        ],
        selection: { anchor: from - marker.length, head: to - marker.length },
        annotations: [yjsOrigin.of(ORIGIN_HUMAN)],
      })
      return true
    }
  }

  // Wrap: add markers around selection
  view.dispatch({
    changes: { from, to, insert: `${marker}${selectedText}${marker}` },
    selection: { anchor: from + marker.length, head: to + marker.length },
    annotations: [yjsOrigin.of(ORIGIN_HUMAN)],
  })
  return true
}

/**
 * Insert a markdown link at the current cursor position.
 * If text is selected, wraps it as the link text with cursor in URL.
 * If no selection, inserts [text](url) template with "text" selected.
 */
export function insertLink(view: EditorView): boolean {
  const { from, to } = view.state.selection.main
  const selectedText = view.state.sliceDoc(from, to)

  if (selectedText) {
    // Wrap selection as link text, place cursor in URL
    view.dispatch({
      changes: { from, to, insert: `[${selectedText}](url)` },
      selection: {
        anchor: from + selectedText.length + 3,
        head: from + selectedText.length + 6,
      },
      annotations: [yjsOrigin.of(ORIGIN_HUMAN)],
    })
  } else {
    // Insert empty link, place cursor in text
    view.dispatch({
      changes: { from, insert: "[text](url)" },
      selection: { anchor: from + 1, head: from + 5 },
      annotations: [yjsOrigin.of(ORIGIN_HUMAN)],
    })
  }
  return true
}
