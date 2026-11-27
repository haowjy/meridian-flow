import type { RoomDocs } from "@meridian/document-model";
import { resolveCursor } from "@meridian/loro-prosemirror";
import type { Editor } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { NodeSelection, Selection, TextSelection } from "@tiptap/pm/state";
import { decodePoint, docsOf, encodePoint, findBlock, pointAt } from "./loro-points";
import type { ReadingAnchor, ReadingPosition } from "./reading-position-store";

function anchor(docs: RoomDocs, doc: Node, pos: number): ReadingAnchor | null {
  const point = pointAt(docs, doc, pos);
  return point ? encodePoint(point) : null;
}

function resolve(docs: RoomDocs, doc: Node, value: ReadingAnchor): number | null {
  const point = decodePoint(value);
  return point && resolveCursor(docs, doc, point);
}

function blockIdIn(node: Node): string | null {
  if (typeof node.attrs.id === "string") return node.attrs.id;
  let id: string | null = null;
  node.descendants((child) => {
    if (id) return false;
    if (typeof child.attrs.id === "string") id = child.attrs.id;
    return id === null;
  });
  return id;
}

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
    const docs = docsOf(editor.state);
    if (!docs) return null;
    const { doc } = editor.state;
    const top = readingLine(editor, pane);
    let viewport: ReadingPosition["viewport"] | null = null;
    editor.state.doc.forEach((node, pos) => {
      if (viewport) return;
      const dom = editor.view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return;
      const rect = dom.getBoundingClientRect();
      if (!rect.height || rect.bottom <= top) return;
      const block = blockIdIn(node);
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
      const text = textPos === null ? null : anchor(docs, doc, textPos);
      const line = textPos === null ? null : editor.view.coordsAtPos(textPos);
      const offset = line
        ? Math.max(0, Math.min(1, (top - line.top) / Math.max(1, line.bottom - line.top)))
        : Math.max(0, Math.min(1, (top - rect.top) / rect.height));
      viewport = { block, text, offset };
    });
    const selection = editor.state.selection;
    const start = anchor(docs, doc, selection.anchor);
    const head = anchor(docs, doc, selection.head);
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
  const docs = docsOf(editor.state);
  if (!docs) return false;
  let scrolled = false;
  try {
    const doc = editor.state.doc;
    const found = findBlock(doc, place.viewport.block);
    const block = found && found.pos + 1;
    const text = place.viewport.text ? resolve(docs, doc, place.viewport.text) : null;
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

    const reading = text ?? block;
    const from = resolve(docs, doc, place.selection.anchor);
    const to = resolve(docs, doc, place.selection.head) ?? from;
    let selection = reading === null ? null : Selection.near(doc.resolve(reading));
    if (from !== null && to !== null) {
      const selectedNode = doc.nodeAt(from);
      const saved =
        place.selection.node && selectedNode && NodeSelection.isSelectable(selectedNode)
          ? NodeSelection.create(doc, from)
          : doc.resolve(from).parent.inlineContent && doc.resolve(to).parent.inlineContent
            ? TextSelection.create(doc, from, to)
            : Selection.near(doc.resolve(from));
      const shown = pane.getBoundingClientRect();
      const head = editor.view.coordsAtPos(saved.head);
      if ((head.bottom > shown.top && head.top < shown.bottom) || !selection) selection = saved;
    }
    if (selection)
      editor.view.dispatch(editor.state.tr.setSelection(selection).setMeta("addToHistory", false));
    return true;
  } catch {
    if (!scrolled) pane.scrollTop = 0;
    return true;
  }
}
