import { inText, type RoomDocs, scoped, shownUnits, textUnits } from "@meridian/document-model";
import { Cursor } from "loro-crdt";
import type { Node, ResolvedPos } from "prosemirror-model";
import type { EditorState } from "prosemirror-state";

/**
 * A place in a textblock as a Loro cursor in the block's text doc, which survives anyone's edits.
 * The cursor is its encoded bytes, a plain value: Loro's `Cursor` is a WASM handle, made and freed
 * around each use.
 */
export interface DocCursor {
  block: string;
  cursor: Uint8Array;
  /** The cursor holds the unit before a caret, which is one past it. */
  after: boolean;
}

export interface SelectionCursors {
  anchor: DocCursor | null;
  head: DocCursor | null;
}

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
  const cursor = inText(doc, (text) => {
    const made = text.getCursor(unit ? unit.pos : 0);
    return made && scoped(made, (each) => each.encode());
  });
  return cursor ? { block: id, cursor, after: offset > 0 && unit !== undefined } : null;
}

export function selectionCursors(docs: RoomDocs, state: EditorState): SelectionCursors {
  const { selection } = state;
  return { anchor: cursorAt(docs, selection.$anchor), head: cursorAt(docs, selection.$head) };
}

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
  const position = scoped(Cursor.decode(at.cursor), (cursor) => text.getCursorPos(cursor));
  if (!position) return null;
  const held = at.after && position.update === undefined;
  position.update?.free();
  let shown = 0;
  for (const unit of textUnits(text, rule, docs.shape)) {
    if (unit.pos >= position.offset) break;
    if (!unit.hidden) shown++;
  }
  return found.start + Math.min(shown + (held ? 1 : 0), found.node.content.size);
}
