/** Resolves selected editor objects and their transactions. */

import { GapCursor } from "@tiptap/pm/gapcursor";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import {
  type EditorState,
  NodeSelection,
  Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";

import { isEditorObject, isOpaqueObject } from "./object-types";

export type ObjectAt = { node: PMNode; pos: number };

/** The object the selection is standing on, or null in prose. */
export function selectedObject(state: EditorState): ObjectAt | null {
  const { selection } = state;

  if (selection instanceof NodeSelection) {
    return isEditorObject(selection.node) ? { node: selection.node, pos: selection.from } : null;
  }

  if (
    selection instanceof CellSelection &&
    selection.isColSelection() &&
    selection.isRowSelection()
  ) {
    const table = selection.$anchorCell.node(-1);
    return isEditorObject(table) ? { node: table, pos: selection.$anchorCell.before(-1) } : null;
  }

  return null;
}

/** The object the caret would walk onto next. */
export function objectBeside(state: EditorState, direction: 1 | -1): ObjectAt | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const $pos = selection.$head;

  const inline = direction === 1 ? $pos.nodeAfter : $pos.nodeBefore;
  if (inline && isEditorObject(inline)) {
    return { node: inline, pos: direction === 1 ? $pos.pos : $pos.pos - inline.nodeSize };
  }

  const atEdge =
    direction === 1 ? $pos.parentOffset === $pos.parent.content.size : $pos.parentOffset === 0;
  if (!atEdge) return null;

  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const parent = $pos.node(depth - 1);
    const siblingIndex = $pos.index(depth - 1) + direction;
    // No sibling at this depth: the edge belongs to the level above, so keep
    // climbing (the last paragraph of a list item shares its edge with the list).
    if (siblingIndex < 0 || siblingIndex >= parent.childCount) continue;

    const sibling = parent.child(siblingIndex);
    let pos = $pos.start(depth - 1);
    for (let index = 0; index < siblingIndex; index += 1) pos += parent.child(index).nodeSize;
    // The immediate neighbour is what "beside" means. A paragraph next door
    // ends the walk rather than hiding an object two blocks away behind it —
    // but a CONTAINER next door (the next cell, the next row) is entered
    // through its edge block, and when that block is an object the walk is
    // standing beside the object (b: a cell whose entry block is a rendered
    // diagram is entered by selecting the diagram, never its hidden source).
    return entryObject(sibling, pos, direction);
  }

  return null;
}

/** The object the caret meets first when it walks into `node` from `direction` (`1` enters through the first block, `-1` through the last), or null when the entry is prose the caret may simply move into. */
function entryObject(node: PMNode, pos: number, direction: 1 | -1): ObjectAt | null {
  if (isEditorObject(node)) return { node, pos };
  if (node.isTextblock || node.isAtom || !node.isBlock || node.childCount === 0) return null;

  const index = direction === 1 ? 0 : node.childCount - 1;
  let childPos = pos + 1;
  for (let child = 0; child < index; child += 1) childPos += node.child(child).nodeSize;
  return entryObject(node.child(index), childPos, direction);
}

/** The object whose INTERIOR `$at` falls in, or null when the position stands in prose. */
function objectAround($at: ResolvedPos, outsideOf?: number): ObjectAt | null {
  return objectAncestor($at, (object) => !encloses(object, outsideOf));
}

/** The same reading, restricted to bodies that stand in for text the page does not show (`isOpaqueObject`). */
export function opaqueObjectAround($at: ResolvedPos): ObjectAt | null {
  return objectAncestor($at, (object) => isOpaqueObject(object.node));
}

/** The shallowest object ancestor of `$at` that `accept` takes. */
function objectAncestor($at: ResolvedPos, accept: (object: ObjectAt) => boolean): ObjectAt | null {
  for (let depth = 1; depth <= $at.depth; depth += 1) {
    const node = $at.node(depth);
    if (!isEditorObject(node)) continue;
    const object = { node, pos: $at.before(depth) };
    if (accept(object)) return object;
  }
  return null;
}

function encloses(object: ObjectAt, pos: number | undefined): boolean {
  return pos !== undefined && pos >= object.pos && pos < object.pos + object.node.nodeSize;
}

/** Select the object at `pos`. Null when the schema refuses a node selection. */
export function selectObjectTransaction(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node || !isEditorObject(node) || !NodeSelection.isSelectable(node)) return null;
  return state.tr.setSelection(NodeSelection.create(state.doc, pos)).scrollIntoView();
}

/** The selection immediately beside the object at `pos` — the second arrow press, which passes beyond what the first press stepped onto. */
export function caretBesideObjectTransaction(
  state: EditorState,
  pos: number,
  direction: 1 | -1,
): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;

  const edge = direction === 1 ? pos + node.nodeSize : pos;
  const selection = Selection.near(state.doc.resolve(edge), direction);
  if (direction === 1 ? selection.from < edge : selection.to > edge) return null;

  const walkedInto = objectAround(selection.$head, pos);
  // A registration the schema refuses a node selection on keeps the plain
  // landing: no row is unselectable today, and an arrow that moves nowhere
  // traps the writer, which is the worse of the two failures ().
  const onto = walkedInto ? selectObjectTransaction(state, walkedInto.pos) : null;
  if (onto) return onto;

  return state.tr.setSelection(selection).scrollIntoView();
}

/** Where Esc lands when it leaves an object ( last step): after it, before it when the object ends the document, and — when the object IS the document — in a paragraph made for the purpose. */
export function caretHomeFromObjectTransaction(
  state: EditorState,
  pos: number,
): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;

  const $after = state.doc.resolve(pos + node.nodeSize);
  const bound = isolatingBoundAround($after);

  // Forward to the first place the writer can type, stepping OVER a leaf that
  // holds no text rather than selecting it. Esc asked to leave object-land, so
  // landing on another selected object would leave the next keystroke poised
  // to replace it — and searching only for the position immediately beside the
  // object is what made a scene break look like a dead end and sent the caret
  // backward into the block above. A rendered diagram is one more thing with
  // no text to offer, whatever the schema says about its `code_block`.
  const forwardText = forwardWriterText(state, $after, bound.end);
  if (forwardText) return state.tr.setSelection(forwardText).scrollIntoView();

  // A scene break can also be the LAST thing in the document, and then there
  // is no text ahead at all. The gap past it is still forward, still a caret,
  // and still somewhere typing works, so it is a home rather than a reason to
  // walk back over the object the writer just left.
  const forwardGap = gapPastFollowingNodes(state, $after);
  if (forwardGap) return state.tr.setSelection(forwardGap).scrollIntoView();

  // Nothing ahead at all: in front of the object beats nowhere.
  const backward = Selection.findFrom(state.doc.resolve(pos), -1, true);
  if (backward && backward.from >= bound.start) {
    return state.tr.setSelection(backward).scrollIntoView();
  }

  return paragraphAfterTransaction(state, $after)?.scrollIntoView() ?? null;
}

/** The interior of the nearest isolating ancestor of `$pos` — the cell, when the position is inside one — or the whole document outside every one. */
function isolatingBoundAround($pos: ResolvedPos): { start: number; end: number } {
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if ($pos.node(depth).type.spec.isolating) {
      return { start: $pos.start(depth), end: $pos.end(depth) };
    }
  }
  return { start: 0, end: $pos.doc.content.size };
}

/** A paragraph made after `$after`, with the caret in it. */
function paragraphAfterTransaction(state: EditorState, $after: ResolvedPos): Transaction | null {
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return null;

  const index = $after.index($after.depth);
  if (!$after.parent.canReplaceWith(index, index, paragraph)) return null;

  const transaction = state.tr.insert($after.pos, paragraph.create());
  return transaction.setSelection(TextSelection.near(transaction.doc.resolve($after.pos), 1));
}

/** Where a printable character lands while an object is selected: the text position after it, or a paragraph made for the purpose. */
export function typeBesideObjectTransaction(
  state: EditorState,
  pos: number,
  text: string,
): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;

  const $after = state.doc.resolve(pos + node.nodeSize);
  const forward = Selection.findFrom($after, 1, true);
  // The same wall Esc's walk respects: the nearest text after an object that
  // ends its cell is the neighbouring cell's, and the letter must not go there.
  const bound = isolatingBoundAround($after);
  const visible =
    forward && forward.from <= bound.end && !opaqueObjectAround(forward.$head) ? forward : null;
  const transaction = visible
    ? state.tr.setSelection(visible)
    : paragraphAfterTransaction(state, $after);
  return transaction?.insertText(text).scrollIntoView() ?? null;
}

/** Remove the object at `pos` outright. */
export function deleteObjectTransaction(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  return state.tr.delete(pos, pos + node.nodeSize).scrollIntoView();
}

/** The first text position forward of `$from` the writer can actually see, at or before `limit` — the isolating bound the search must not leave. */
function forwardWriterText(
  state: EditorState,
  $from: ResolvedPos,
  limit: number,
): Selection | null {
  let $at = $from;
  for (;;) {
    const found = Selection.findFrom($at, 1, true);
    if (!found || found.from > limit) return null;

    const hidden = opaqueObjectAround(found.$head);
    if (!hidden) return found;

    const past = hidden.pos + hidden.node.nodeSize;
    if (past <= $at.pos) return null;
    $at = state.doc.resolve(past);
  }
}

/** The first gap cursor at or past the siblings following `from`. */
function gapPastFollowingNodes(state: EditorState, from: ResolvedPos): Selection | null {
  const parent = from.parent;
  let pos = from.pos;

  for (let index = from.index(from.depth); index < parent.childCount; index += 1) {
    pos += parent.child(index).nodeSize;
    const $gap = state.doc.resolve(pos);
    if (gapCursorFits($gap)) return new GapCursor($gap);
  }

  return null;
}

/** prosemirror-gapcursor ships `GapCursor.valid` but does not declare it, so the reach into an undeclared static lives here and nowhere else. */
export function gapCursorFits($pos: ResolvedPos): boolean {
  const gapCursor = GapCursor as unknown as { valid?: (at: ResolvedPos) => boolean };
  return gapCursor.valid?.($pos) ?? false;
}

/** Enter's `caret-inside` engagement: the first text position within. */
export function caretInsideObjectTransaction(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node || node.isAtom || node.content.size === 0) return null;
  const selection = TextSelection.near(state.doc.resolve(pos + 1), 1);
  return state.tr.setSelection(selection).scrollIntoView();
}
