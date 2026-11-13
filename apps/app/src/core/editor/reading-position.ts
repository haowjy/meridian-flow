/** Document-relative viewport and selection capture/restore over the live Yjs binding. */
import type { Editor } from "@tiptap/core";
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import * as Y from "yjs";
import type { ReadingAnchor, ReadingPosition } from "./reading-position-store";
import {
  type RelativePositionRuntime,
  relativePositionForIndex,
  relativePositionRuntimeFromState,
  resolveRelativePosition,
} from "./relative-position-runtime";

function anchor(runtime: RelativePositionRuntime, pos: number): ReadingAnchor | null {
  const relative = relativePositionForIndex(runtime, pos);
  return relative ? Array.from(Y.encodeRelativePosition(relative)) : null;
}
function resolve(runtime: RelativePositionRuntime, value: ReadingAnchor): number | null {
  try {
    return resolveRelativePosition(runtime, Y.decodeRelativePosition(Uint8Array.from(value)));
  } catch {
    return null;
  }
}

/**
 * The reading line: the top of the prose column, below its top inset. Measured from the pane's
 * edge instead, a document read from its first line reopens scrolled by the inset.
 */
function readingLine(editor: Editor, pane: HTMLElement): number {
  return (
    pane.getBoundingClientRect().top +
    pane.clientTop +
    Number.parseFloat(getComputedStyle(editor.view.dom).paddingTop)
  );
}

export function captureReadingPosition(editor: Editor, pane: HTMLElement): ReadingPosition | null {
  if (editor.isDestroyed) return null;
  try {
    const runtime = relativePositionRuntimeFromState(editor.state);
    if (!runtime) return null;
    const top = readingLine(editor, pane);
    let viewport: ReadingPosition["viewport"] | null = null;
    editor.state.doc.forEach((node, pos) => {
      if (viewport) return;
      const dom = editor.view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return;
      const rect = dom.getBoundingClientRect();
      if (!rect.height || rect.bottom <= top) return;
      // Inside the block rather than before it: edits inserted above stay above.
      const block = anchor(runtime, Math.min(pos + 1, pos + node.nodeSize - 1));
      if (!block) return;
      const hit = editor.view.posAtCoords({
        left: rect.left + 1,
        top: Math.max(top, rect.top + 1),
      });
      const textPos =
        hit &&
        hit.pos > pos &&
        hit.pos < pos + node.nodeSize &&
        editor.state.doc.resolve(hit.pos).parent.isTextblock
          ? hit.pos
          : null;
      const text = textPos === null ? null : anchor(runtime, textPos);
      const line = textPos === null ? null : editor.view.coordsAtPos(textPos);
      // Dimensionless line offset (or block fraction for opaque content), never pixels.
      const offset = line
        ? Math.max(0, Math.min(1, (top - line.top) / Math.max(1, line.bottom - line.top)))
        : Math.max(0, Math.min(1, (top - rect.top) / rect.height));
      viewport = { block, text, offset };
    });
    const selection = editor.state.selection;
    const start = anchor(runtime, selection.anchor);
    const head = anchor(runtime, selection.head);
    if (!viewport || !start || !head) return null;
    return {
      viewport,
      selection: { anchor: start, head, node: selection instanceof NodeSelection },
    };
  } catch {
    return null;
  }
}

/**
 * Scroll to the saved reading line, then restore the selection, without focus or scrollIntoView.
 * A selection the restored viewport doesn't show (the writer scrolled without clicking, or away
 * from a passage they selected) becomes a caret at the reading line instead: left off-screen, the
 * first focus or keystroke scrolls back to it, and ProseMirror's own post-focus check does exactly
 * that for a selection at the document start.
 */
export function restoreReadingPosition(
  editor: Editor,
  pane: HTMLElement,
  place: ReadingPosition,
): boolean {
  if (editor.isDestroyed) return false;
  const runtime = relativePositionRuntimeFromState(editor.state);
  if (!runtime) return false;
  let scrolled = false;
  try {
    const doc = editor.state.doc;
    const block = resolve(runtime, place.viewport.block);
    const text = place.viewport.text ? resolve(runtime, place.viewport.text) : null;
    const top = readingLine(editor, pane);
    if (text !== null && doc.resolve(text).parent.isTextblock) {
      const line = editor.view.coordsAtPos(text);
      pane.scrollTop += line.top - top + place.viewport.offset * (line.bottom - line.top);
    } else if (block !== null) {
      const at = doc.resolve(block);
      const dom = editor.view.nodeDOM(at.depth ? at.before(1) : block);
      if (dom instanceof HTMLElement) {
        const rect = dom.getBoundingClientRect();
        pane.scrollTop += rect.top - top + place.viewport.offset * rect.height;
      } else pane.scrollTop = 0;
    } else pane.scrollTop = 0;
    scrolled = true;

    const from = resolve(runtime, place.selection.anchor) ?? 0;
    const to = resolve(runtime, place.selection.head) ?? from;
    const selectedNode = doc.nodeAt(from);
    const saved =
      place.selection.node && selectedNode && NodeSelection.isSelectable(selectedNode)
        ? NodeSelection.create(doc, from)
        : doc.resolve(from).parent.inlineContent && doc.resolve(to).parent.inlineContent
          ? TextSelection.create(doc, from, to)
          : Selection.near(doc.resolve(from));
    const shown = pane.getBoundingClientRect();
    const head = editor.view.coordsAtPos(saved.head);
    const reading = text ?? block;
    const selection =
      (head.bottom > shown.top && head.top < shown.bottom) || reading === null
        ? saved
        : Selection.near(doc.resolve(reading));
    editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta("addToHistory", false));
    return true;
  } catch {
    // Deleted types, replaced content, and unavailable layout are convenience loss, never a broken editor.
    if (!scrolled) pane.scrollTop = 0;
    return true;
  }
}
