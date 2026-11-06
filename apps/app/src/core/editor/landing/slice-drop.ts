/**
 * The slice door: text and node drags inside the editor, and text dragged in
 * from outside. A slice lands where the landing says, as PM's own drop would;
 * in a table cell, one that can't keep the grid lands as its text.
 */

import { t } from "@lingui/core/macro";
import type { Node as PMNode, Slice } from "@tiptap/pm/model";
import {
  type EditorState,
  NodeSelection,
  type Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { dropPoint } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";

import type { DropDoor, DropPlan } from "./drop-plan";
import { isTable, isTableCell, type Landing } from "./point-landing";

type SliceSource = {
  moved: boolean;
  /** The dragged node's own selection, when the drag carried one. */
  node: Selection | null;
};

const copyModifier = /Mac/i.test(globalThis.navigator?.platform ?? "") ? "altKey" : "ctrlKey";

/**
 * The drag's source, read from `view.dragging`. ProseMirror keeps the node
 * selection there for its own drop handler but leaves it out of the public
 * type; without it a moved node's deletion would fall back to whatever the
 * document selection happens to be.
 */
export function dragSource(view: EditorView, event: DragEvent): SliceSource {
  const dragging = view.dragging as { node?: NodeSelection } | null;
  return { moved: Boolean(dragging) && !event[copyModifier], node: dragging?.node ?? null };
}

/** Drags inside the editor, and text dragged in from outside whose content is unknown until the drop. */
export const sliceDoor: DropDoor = {
  plan({ view }, landing, event) {
    return slicePlan(view, landing, view.dragging?.slice ?? null, dragSource(view, event));
  },
};

/**
 * `handleDrop`'s plan: the slice ProseMirror resolved for this drop, landed at
 * `landing`. Text from outside is read again where it lands (see below).
 */
export function droppedSlicePlan(
  view: EditorView,
  event: DragEvent,
  slice: Slice,
  landing: Landing,
): DropPlan {
  const source = dragSource(view, event);
  return slicePlan(
    view,
    landing,
    view.dragging ? slice : (reparsedOutsideCode(view, event, landing) ?? slice),
    source,
  );
}

/**
 * Text from outside, dropped beside a rendered diagram. ProseMirror parsed it
 * against the raw position, inside the diagram's hidden fence, and handed back
 * literal characters; the landing is outside it, so the text is read again as
 * the host would read it there. Null when nothing needs reading again, or the
 * host has no text parser (the literal slice stands).
 */
function reparsedOutsideCode(view: EditorView, event: DragEvent, landing: Landing): Slice | null {
  if (landing.kind === "source") return null;
  const raw = view.posAtCoords({ left: event.clientX, top: event.clientY });
  if (!raw || !view.state.doc.resolve(raw.pos).parent.type.spec.code) return null;
  const text = event.dataTransfer?.getData("text/plain");
  if (!text) return null;

  const $landing = view.state.doc.resolve(landing.pos);
  let slice = view.someProp("clipboardTextParser", (parse) => parse(text, $landing, false, view));
  if (!slice) return null;
  view.someProp("transformPasted", (transform) => {
    slice = transform(slice as Slice, view, false);
  });
  return slice;
}

/**
 * The plan for a slice at `landing`. A null slice is an external drag still in
 * the air: its content is unknown, so the caret is the landing.
 */
function slicePlan(
  view: EditorView,
  landing: Landing,
  slice: Slice | null,
  source: SliceSource,
): DropPlan {
  const { state } = view;
  if (!slice) return { kind: "accept", pos: landing.pos };
  if (source.moved && overlapsMovedBlock(state, landing, source)) return { kind: "refuse" };

  if (landing.kind === "source") {
    return textPlan(state, landing.pos, slice, source, "\n", t`Can’t put that inside code`);
  }

  // A block slice settles where ProseMirror's own fit would put it, so the
  // caret draws that position.
  const pos =
    landing.kind === "inline"
      ? (dropPoint(state.doc, landing.pos, slice) ?? landing.pos)
      : landing.pos;
  const built = sliceDropTransaction(state, pos, slice, source);
  if (built && keepsTableShape(state, pos, built)) {
    return { kind: "accept", pos, commit: (target) => finish(target, built.transaction) };
  }
  // Nothing in a table cell may change the grid, spill out of the cell or nest
  // a table: what can't be kept whole lands as its text.
  if (!cellAround(state, pos)) return { kind: "refuse" };
  const $landing = state.doc.resolve(landing.pos);
  const at = $landing.parent.isTextblock ? landing.pos : TextSelection.near($landing, -1).from;
  return textPlan(state, at, slice, source, " ", t`Can’t put that in a table cell`);
}

/**
 * A slice read as characters, landed at `pos` inside a textblock. `breaks` is
 * what a block boundary or hard break becomes. A leaf other than a hard break
 * (a picture, a chip) has no text to give, and a move would delete it for
 * nothing, so such a slice is refused with `refusal`, as is one whose text
 * would still break a table.
 */
function textPlan(
  state: EditorState,
  pos: number,
  slice: Slice,
  source: SliceSource,
  breaks: string,
  refusal: string,
): DropPlan {
  let leaves = true;
  slice.content.descendants((node) => {
    if (node.isLeaf && !node.isText && !node.type.spec.linebreakReplacement) leaves = false;
  });
  const text = slice.content.textBetween(0, slice.content.size, breaks, breaks);
  if (!leaves || !text) return { kind: "refuse", hint: refusal };

  const transaction = state.tr;
  deleteSource(transaction, source);
  const at = transaction.mapping.map(pos);
  transaction.insertText(text, at);
  transaction.setSelection(TextSelection.create(transaction.doc, at + text.length));
  const from = transaction.mapping.map(pos, -1);
  if (!keepsTableShape(state, pos, { transaction, from, to: from + text.length })) {
    return { kind: "refuse", hint: refusal };
  }
  return { kind: "accept", pos, commit: (target) => finish(target, transaction) };
}

function finish(view: EditorView, transaction: Transaction): void {
  view.focus();
  transaction.setMeta("uiEvent", "drop");
  view.dispatch(transaction);
}

function deleteSource(transaction: Transaction, source: SliceSource): void {
  if (!source.moved) return;
  if (source.node) source.node.replace(transaction);
  else transaction.deleteSelection();
}

/**
 * True when this move lands inside the dragged range, or in a textblock the
 * range reaches into from outside: deleting the range would cut that block and
 * flatten what it held into the rest of it. A range wholly inside the block is
 * an ordinary move within a line.
 */
function overlapsMovedBlock(state: EditorState, landing: Landing, source: SliceSource): boolean {
  const range = source.node ?? state.selection;
  if (landing.pos >= range.from && landing.pos <= range.to) return true;
  const $pos = state.doc.resolve(landing.pos);
  if (!$pos.parent.isTextblock) return false;
  const overlaps = range.from < $pos.end() && range.to > $pos.start();
  const inside = range.from >= $pos.start() && range.to <= $pos.end();
  return overlaps && !inside;
}

type BuiltDrop = { transaction: Transaction; from: number; to: number };

/**
 * The transaction one slice drop dispatches, with the range it inserts in the
 * new document, or null when it changes nothing. Mirrors ProseMirror's own
 * drop: move-delete, node-vs-slice insert, landing selection.
 */
function sliceDropTransaction(
  state: EditorState,
  pos: number,
  slice: Slice,
  source: SliceSource,
): BuiltDrop | null {
  const transaction = state.tr;
  deleteSource(transaction, source);
  const mapped = transaction.mapping.map(pos);
  const single =
    slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1
      ? slice.content.firstChild
      : null;
  const beforeInsert = transaction.doc;
  if (single) transaction.replaceRangeWith(mapped, mapped, single);
  else transaction.replaceRange(mapped, mapped, slice);
  if (transaction.doc.eq(beforeInsert)) return null;

  // Assoc -1 keeps an insertion at `pos` from pushing the start past its own content.
  const from = transaction.mapping.map(pos, -1);
  let end = from;
  transaction.mapping.maps.at(-1)?.forEach((_from, _to, _newFrom, newTo) => {
    end = newTo;
  });
  const $landing = transaction.doc.resolve(mapped);
  if (single && NodeSelection.isSelectable(single) && $landing.nodeAfter?.sameMarkup(single)) {
    transaction.setSelection(new NodeSelection($landing));
  } else {
    transaction.setSelection(TextSelection.between($landing, transaction.doc.resolve(end)));
  }
  return { transaction, from, to: end };
}

function sameGrid(a: PMNode, b: PMNode): boolean {
  if (a.childCount !== b.childCount) return false;
  for (let row = 0; row < a.childCount; row++) {
    if (a.child(row).childCount !== b.child(row).childCount) return false;
  }
  return true;
}

/** The cell around `pos`, or null outside a cell inside a table. */
function cellAround(state: EditorState, pos: number): { cell: number | null } | null {
  const $pos = state.doc.resolve(pos);
  let cell: number | null = null;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (cell === null && isTableCell(node)) cell = $pos.before(depth);
    if (isTable(node)) return { cell };
  }
  return null;
}

/**
 * True when a drop leaves every table with the grid it had (one the drop
 * deletes whole is gone, not changed), puts no table inside a cell (Markdown
 * can't hold one), and keeps the inserted range inside the cell it landed in.
 * The fitter is free to improvise a landing beyond the cell; a landing the
 * caret never promised is not kept. A drop outside any table always passes.
 */
function keepsTableShape(
  before: EditorState,
  pos: number,
  { transaction, from, to }: BuiltDrop,
): boolean {
  const shape = cellAround(before, pos);
  if (!shape) return true;
  if (shape.cell === null) return false;

  let grids = true;
  before.doc.descendants((node, at) => {
    if (!grids || !isTable(node)) return grids;
    const mapped = transaction.mapping.mapResult(at, 1);
    if (!mapped.deletedAfter) {
      const now = transaction.doc.nodeAt(mapped.pos);
      grids = Boolean(now && isTable(now) && sameGrid(node, now));
    }
    return false;
  });
  if (!grids) return false;

  const cellPos = transaction.mapping.map(shape.cell, -1);
  const cell = transaction.doc.nodeAt(cellPos);
  if (!cell || !isTableCell(cell)) return false;
  let nested = false;
  cell.descendants((node) => {
    if (isTable(node)) nested = true;
    return !nested;
  });
  return !nested && from >= cellPos + 1 && to <= cellPos + 1 + cell.content.size;
}
