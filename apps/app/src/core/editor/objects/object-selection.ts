/**
 * The document half of object physics: what is selected, what is beside it,
 * and where the caret lands when you walk past.
 *
 * Pure over `EditorState` — every function returns a `Transaction` or a
 * reading, never dispatches. The extension beside it does the dispatching, so
 * the walk itself can be reasoned about (and tested) without a view.
 */

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

/**
 * The object the selection is standing on, or null in prose.
 *
 * Two spellings, because a table cannot have the first one. prosemirror-tables
 * normalizes a `NodeSelection` on a table into a `CellSelection` over every
 * cell, so that — a selection that is both a whole column and a whole row — IS
 * how "this table is selected" is written in this schema. Reading only
 * `NodeSelection` would make arrow-walk, Enter, and Esc all quietly skip
 * tables.
 */
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

/**
 * The object the caret would walk onto next (§4: "arrow keys crossing an
 * object → the object becomes selected").
 *
 * Two neighbourhoods, in order. An inline image sits inside the paragraph, so
 * it is beside the caret directly. A block object is beside the caret only at
 * the very edge of its text block — arrowing through prose must never leap out
 * of the sentence, so a caret one character short of the end walks a character.
 */
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
    // The immediate neighbour is what "beside" means. A paragraph next door
    // ends the walk rather than hiding an object two blocks away behind it.
    if (!isEditorObject(sibling)) return null;

    let pos = $pos.start(depth - 1);
    for (let index = 0; index < siblingIndex; index += 1) pos += parent.child(index).nodeSize;
    return { node: sibling, pos };
  }

  return null;
}

/**
 * The object whose INTERIOR `$at` falls in, or null when the position stands in
 * prose. Shallowest first, so a diagram inside a table cell answers with the
 * table: the walk crosses the outer object as one thing.
 *
 * `outsideOf` is the object the reading is standing on already — the one an
 * arrow press is leaving. Without it a walk between two blocks of the same
 * table would answer "the table", and the writer moving from one cell to the
 * next would find the whole grid selected.
 */
function objectAround($at: ResolvedPos, outsideOf?: number): ObjectAt | null {
  return objectAncestor($at, (object) => !encloses(object, outsideOf));
}

/**
 * The same reading, restricted to bodies that stand in for text the page does
 * not show (`isOpaqueObject`).
 *
 * This is the one every caret landing has to consult, whatever put it there: a
 * position inside a rendered diagram is a position in source the writer is not
 * looking at, and landing there both swallows the next keystroke and flips the
 * diagram back into its syntax. A table's cell is the opposite case and stays a
 * fine place to land — it shows its own text.
 */
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

/**
 * The selection immediately beside the object at `pos` — the second arrow
 * press, which passes beyond what the first press stepped onto.
 *
 * Null when that side is a dead end. ProseMirror's `near` quietly searches the
 * other way rather than failing, and for an arrow key that is exactly wrong:
 * pressing Right on the last block in the document must not move the caret
 * left. The test is POSITIONAL, not a type check — a leaf atom sitting against
 * the object (a scene break) is a legitimate landing that arrow-walk should
 * step onto, and reading "not a TextSelection" as "dead end" is what once sent
 * Esc backward past the object it was leaving.
 *
 * **The step beside an object may land on the next object, never inside it.**
 * `Selection.near` reads the schema and nothing else: it steps onto a leaf,
 * and it descends into anything ProseMirror calls a textblock — which a
 * rendered diagram is, so a writer arrowing off the rule below one landed in
 * the mermaid source and the fence flipped from the picture to its syntax
 * (human ruling, 2026-07-30: arrows select the diagram and never reveal it).
 * The registration is what says otherwise, so the landing is read back through
 * it, and this half of the walk now answers as `objectBeside` already did for
 * the half that starts in prose: every object is stepped ONTO, and the press
 * after that is what passes it.
 */
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
  // traps the writer, which is the worse of the two failures (law 3).
  const onto = walkedInto ? selectObjectTransaction(state, walkedInto.pos) : null;
  if (onto) return onto;

  return state.tr.setSelection(selection).scrollIntoView();
}

/**
 * Where Esc lands when it leaves an object (law 3's last step): after it,
 * before it when the object ends the document, and — when the object IS the
 * document — in a paragraph made for the purpose.
 *
 * That last case is a write to the shared document on a dismissal, which is
 * not something to do lightly. It is still right: a chapter whose only content
 * is one diagram has no prose to go home to, and law 3 says nobody is ever
 * trapped. One empty paragraph is a smaller cost than a writer standing on a
 * thing they asked to leave, and it is a paragraph any editor would have given
 * them anyway. Yjs carries it like any other edit and undo takes it back.
 *
 * Null only when the schema refuses a paragraph there — a code-schema
 * document, whose one block is the whole file by definition.
 */
export function caretHomeFromObjectTransaction(
  state: EditorState,
  pos: number,
): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;

  const $after = state.doc.resolve(pos + node.nodeSize);

  // Forward to the first place the writer can type, stepping OVER a leaf that
  // holds no text rather than selecting it. Esc asked to leave object-land, so
  // landing on another selected object would leave the next keystroke poised
  // to replace it — and searching only for the position immediately beside the
  // object is what made a scene break look like a dead end and sent the caret
  // backward into the block above. A rendered diagram is one more thing with
  // no text to offer, whatever the schema says about its `code_block`.
  const forwardText = forwardWriterText(state, $after);
  if (forwardText) return state.tr.setSelection(forwardText).scrollIntoView();

  // A scene break can also be the LAST thing in the document, and then there
  // is no text ahead at all. The gap past it is still forward, still a caret,
  // and still somewhere typing works, so it is a home rather than a reason to
  // walk back over the object the writer just left.
  const forwardGap = gapPastFollowingNodes(state, $after);
  if (forwardGap) return state.tr.setSelection(forwardGap).scrollIntoView();

  // Nothing ahead at all: in front of the object beats nowhere.
  const backward = Selection.findFrom(state.doc.resolve(pos), -1, true);
  if (backward) return state.tr.setSelection(backward).scrollIntoView();

  return paragraphAfterTransaction(state, $after)?.scrollIntoView() ?? null;
}

/**
 * A paragraph made after `$after`, with the caret in it.
 *
 * The one write to the shared document these transactions make, and both
 * callers need it for the same reason: an object that IS the document has no
 * prose to stand in, and one empty paragraph is a smaller cost than a writer
 * with nowhere to type. Null when the schema refuses a paragraph there — a
 * code-schema document, whose one block is the whole file by definition.
 */
function paragraphAfterTransaction(state: EditorState, $after: ResolvedPos): Transaction | null {
  const paragraph = state.schema.nodes.paragraph;
  if (!paragraph) return null;

  const index = $after.index($after.depth);
  if (!$after.parent.canReplaceWith(index, index, paragraph)) return null;

  const transaction = state.tr.insert($after.pos, paragraph.create());
  return transaction.setSelection(TextSelection.near(transaction.doc.resolve($after.pos), 1));
}

/**
 * Where a printable character lands while an object is selected: the text
 * position after it, or a paragraph made for the purpose.
 *
 * A letter is not a destructive verb. ProseMirror's answer is to replace the
 * selection, so the picture a writer was looking at a moment ago disappears
 * under the first thing they type, and a table selected whole loses every
 * cell — and neither is something anyone attributes to the "Q". Delete and
 * Backspace still delete; those said so.
 *
 * Unlike Esc's walk home this never lands in FRONT of the object. The writer
 * is typing forward, so a paragraph after it beats a caret before it.
 *
 * A diagram standing next in line is why the paragraph is made rather than
 * looked for past it: the nearest text position after the object was the
 * mermaid source, so the letter went into a picture's syntax instead of the
 * manuscript. The letter belongs where the writer is looking, which is the
 * space right after the thing they had selected.
 */
export function typeBesideObjectTransaction(
  state: EditorState,
  pos: number,
  text: string,
): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;

  const $after = state.doc.resolve(pos + node.nodeSize);
  const forward = Selection.findFrom($after, 1, true);
  const visible = forward && !opaqueObjectAround(forward.$head) ? forward : null;
  const transaction = visible
    ? state.tr.setSelection(visible)
    : paragraphAfterTransaction(state, $after);
  return transaction?.insertText(text).scrollIntoView() ?? null;
}

/**
 * Remove the object at `pos` outright.
 *
 * The node, not the selection. A table's selection is a `CellSelection` over
 * every cell, and replacing THAT empties every cell and leaves the grid
 * standing — the writer asked to remove a table and got a blank one. Undo
 * recovers from either, but only one of them is what they pressed the key for.
 */
export function deleteObjectTransaction(state: EditorState, pos: number): Transaction | null {
  const node = state.doc.nodeAt(pos);
  if (!node) return null;
  return state.tr.delete(pos, pos + node.nodeSize).scrollIntoView();
}

/**
 * The first text position forward of `$from` the writer can actually see.
 *
 * `Selection.findFrom` with `textOnly` finds a position ProseMirror is willing
 * to put a caret in, which includes the inside of every opaque object with text
 * in it — a rendered diagram's source. So each candidate is read back through
 * the registration, and one that fell inside a diagram resumes the search on
 * the far side of it. The skip is the whole object, not the next position
 * along, or the search would walk the source a line at a time.
 */
function forwardWriterText(state: EditorState, $from: ResolvedPos): Selection | null {
  let $at = $from;
  for (;;) {
    const found = Selection.findFrom($at, 1, true);
    if (!found) return null;

    const hidden = opaqueObjectAround(found.$head);
    if (!hidden) return found;

    const past = hidden.pos + hidden.node.nodeSize;
    if (past <= $at.pos) return null;
    $at = state.doc.resolve(past);
  }
}

/**
 * The first gap cursor at or past the siblings following `from`.
 *
 * Not `GapCursor.findFrom`, which stops dead at a selectable node: from just
 * after a diagram it sees the scene break next door, reports no gap, and the
 * walk falls through to searching backward. The gap the writer wants is on the
 * FAR side of that leaf. Nothing is found when the object is itself last,
 * which leaves the trailing-object cases below to answer as they always have.
 */
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

/**
 * prosemirror-gapcursor ships `GapCursor.valid` but does not declare it, so
 * the reach into an undeclared static lives here and nowhere else. Asking the
 * library beats reimplementing its rule: whether a gap cursor belongs at a
 * position depends on what closes either side of it and on the parent's
 * `allowGapCursor`, and a copy of that would drift on the next upgrade.
 */
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
