/**
 * The slice door: text and node drags inside the editor, and text dragged in
 * from outside. A slice lands where the landing says, as PM's own drop would,
 * with the table's shape held fixed.
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

  if (landing.kind === "source") {
    // A code block holds characters: a slice reads as its text and its hard
    // breaks. Any other leaf (a picture, a chip) has none to give, and a move
    // would delete it for nothing.
    let leaves = true;
    slice.content.descendants((node) => {
      if (node.isLeaf && !node.isText && !node.type.spec.linebreakReplacement) leaves = false;
    });
    const text = slice.content.textBetween(0, slice.content.size, "\n", "\n");
    if (!leaves || !text) return { kind: "refuse", hint: t`Can’t put that inside code` };
    // Released on the range it came from, a move changes nothing.
    if (source.moved) {
      const range = source.node ?? state.selection;
      if (landing.pos >= range.from && landing.pos <= range.to) return { kind: "refuse" };
    }
    return {
      kind: "accept",
      pos: landing.pos,
      commit(target) {
        const transaction = target.state.tr;
        deleteSource(transaction, source);
        const at = transaction.mapping.map(landing.pos);
        transaction.insertText(text, at);
        transaction.setSelection(TextSelection.create(transaction.doc, at + text.length));
        finish(target, transaction);
      },
    };
  }

  // A block slice settles where ProseMirror's own fit would put it, so the
  // caret draws that position.
  const pos =
    landing.kind === "inline"
      ? (dropPoint(state.doc, landing.pos, slice) ?? landing.pos)
      : landing.pos;
  const built = sliceDropTransaction(state, pos, slice, source);
  if (!built || !keepsTableShape(state, pos, built)) return { kind: "refuse" };
  return { kind: "accept", pos, commit: (target) => finish(target, built.transaction) };
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

function rowWidths(table: PMNode): number[] {
  const widths: number[] = [];
  table.forEach((row) => {
    widths.push(row.childCount);
  });
  return widths;
}

/** The pressed cell and table around `pos`, or null outside a table. */
function tableAround(state: EditorState, pos: number) {
  const $pos = state.doc.resolve(pos);
  let cell: number | null = null;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (cell === null && isTableCell(node)) cell = $pos.before(depth);
    if (isTable(node)) return { table: $pos.before(depth), cell, rows: rowWidths(node) };
  }
  return null;
}

/**
 * A drop never changes a table's grid and never spills out of the cell it
 * landed in: the fitter is free to improvise a landing beyond it, and a landing
 * the caret never promised is a refusal, not a surprise.
 */
function keepsTableShape(
  before: EditorState,
  pos: number,
  { transaction, from, to }: BuiltDrop,
): boolean {
  const shape = tableAround(before, pos);
  if (!shape) return true;
  if (shape.cell === null) return false;

  const table = transaction.doc.nodeAt(transaction.mapping.map(shape.table, -1));
  if (!table || !isTable(table)) return false;
  const rows = rowWidths(table);
  if (rows.length !== shape.rows.length || rows.some((width, index) => width !== shape.rows[index]))
    return false;

  const cellPos = transaction.mapping.map(shape.cell, -1);
  const cell = transaction.doc.nodeAt(cellPos);
  if (!cell || !isTableCell(cell)) return false;
  return from >= cellPos + 1 && to <= cellPos + 1 + cell.content.size;
}
