import { type RoomDocs, shownUnits, TEXT_KEY, textUnits } from "@meridian/document-model";
import type { Cursor } from "loro-crdt";
import type { Node, ResolvedPos } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";

/** A place in a textblock as a Loro cursor in the block's text doc, which survives anyone's edits. */
export interface DocCursor {
  block: string;
  cursor: Cursor;
  /** The cursor holds the unit before a caret, which is one past it. */
  after: boolean;
}

/** A selection's ends as cursors; an end outside any textblock the docs hold is null. */
export interface SelectionCursors {
  anchor: DocCursor | null;
  head: DocCursor | null;
}

/** The cursor at `$pos`, when it is inside a textblock the docs hold. */
export function cursorAt(docs: RoomDocs, $pos: ResolvedPos): DocCursor | null {
  const block = $pos.parent;
  const id = block.attrs.id;
  if (!block.isTextblock || typeof id !== "string") return null;
  const doc = docs.textOf(id);
  const rule = docs.shape.node(block.type.name);
  if (!doc || !rule) return null;
  const units = shownUnits(doc, rule, docs.shape);
  const offset = $pos.parentOffset;
  const unit = units[offset > 0 ? offset - 1 : offset];
  const cursor = doc.getText(TEXT_KEY).getCursor(unit ? unit.pos : 0);
  return cursor ? { block: id, cursor, after: offset > 0 && unit !== undefined } : null;
}

/** The selection's ends as cursors in their blocks' text docs, taken while editor and docs agree. */
export function selectionCursors(docs: RoomDocs, state: EditorState): SelectionCursors {
  const { selection } = state;
  return { anchor: cursorAt(docs, selection.$anchor), head: cursorAt(docs, selection.$head) };
}

/** Where the textblock `id` starts in `doc`, and the block. */
export function textblockOf(doc: Node, id: string): { node: Node; start: number } | null {
  let found: { node: Node; start: number } | null = null;
  doc.descendants((child, pos) => {
    if (found) return false;
    if (child.isTextblock && child.attrs.id === id) {
      found = { node: child, start: pos + 1 };
      return false;
    }
    return !child.isTextblock;
  });
  return found;
}

/**
 * The editor position a cursor stands at now, if its block still shows. A cursor whose held unit
 * was deleted stands where the unit was, so the caret that followed the unit is there too.
 */
export function resolveCursor(docs: RoomDocs, doc: Node, at: DocCursor): number | null {
  const text = docs.textOf(at.block);
  const found = text && textblockOf(doc, at.block);
  const rule = found && docs.shape.node(found.node.type.name);
  if (!text || !found || !rule) return null;
  const position = text.getCursorPos(at.cursor);
  if (!position) return null;
  let shown = 0;
  for (const unit of textUnits(text, rule, docs.shape)) {
    if (unit.pos >= position.offset) break;
    if (!unit.hidden) shown++;
  }
  const held = at.after && position.update === undefined;
  return found.start + Math.min(shown + (held ? 1 : 0), found.node.content.size);
}
