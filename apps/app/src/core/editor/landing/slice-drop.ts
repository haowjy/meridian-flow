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

import type { DropPlan } from "./drop-plan";
import type { Landing } from "./point-landing";

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

/**
 * The plan for a slice at `landing`. A null slice is an external drag still in
 * the air: its content is unknown, so the caret is the landing.
 */
export function slicePlan(
  view: EditorView,
  landing: Landing,
  slice: Slice | null,
  source: SliceSource,
): DropPlan {
  const { state } = view;
  if (!slice) return { kind: "accept", pos: landing.pos, commit: () => {} };

  if (landing.kind === "source") {
    // A code block holds characters: a slice reads as its text and its hard
    // breaks. Any other leaf (a picture, a chip) has none to give, and a move
    // would delete it for nothing.
    let leaves = true;
    slice.content.descendants((node) => {
      if (node.isLeaf && !node.isText && node.type.name !== "hard_break") leaves = false;
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
  const transaction = sliceDropTransaction(state, pos, slice, source);
  if (!transaction || !keepsTableShape(state, pos, transaction)) return { kind: "refuse" };
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
 * The transaction one slice drop dispatches, or null when it changes nothing.
 * Mirrors ProseMirror's own drop: move-delete, node-vs-slice insert, landing
 * selection.
 */
function sliceDropTransaction(
  state: EditorState,
  pos: number,
  slice: Slice,
  source: SliceSource,
): Transaction | null {
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

  let end = transaction.mapping.map(pos);
  transaction.mapping.maps.at(-1)?.forEach((_from, _to, _newFrom, newTo) => {
    end = newTo;
  });
  const $landing = transaction.doc.resolve(mapped);
  if (single && NodeSelection.isSelectable(single) && $landing.nodeAfter?.sameMarkup(single)) {
    transaction.setSelection(new NodeSelection($landing));
  } else {
    transaction.setSelection(TextSelection.between($landing, transaction.doc.resolve(end)));
  }
  return transaction;
}

function tableRole(node: PMNode): unknown {
  return node.type.spec.tableRole;
}

/** The pressed cell and table around `pos`, or null outside a table. */
function tableAround(state: EditorState, pos: number) {
  const $pos = state.doc.resolve(pos);
  let cell: number | null = null;
  for (let depth = $pos.depth; depth > 0; depth--) {
    const role = tableRole($pos.node(depth));
    if (cell === null && (role === "cell" || role === "header_cell")) cell = $pos.before(depth);
    if (role === "table") {
      const rows: number[] = [];
      $pos.node(depth).forEach((row) => {
        rows.push(row.childCount);
      });
      return { table: $pos.before(depth), cell, rows };
    }
  }
  return null;
}

/**
 * A drop never changes a table's grid and never spills out of the cell it
 * landed in: the fitter is free to improvise a landing beyond it, and a landing
 * the caret never promised is a refusal, not a surprise.
 */
function keepsTableShape(before: EditorState, pos: number, transaction: Transaction): boolean {
  const shape = tableAround(before, pos);
  if (!shape) return true;
  if (shape.cell === null) return false;

  const table = transaction.doc.nodeAt(transaction.mapping.map(shape.table, -1));
  if (!table || tableRole(table) !== "table") return false;
  const rows: number[] = [];
  table.forEach((row) => {
    rows.push(row.childCount);
  });
  if (rows.length !== shape.rows.length || rows.some((width, index) => width !== shape.rows[index]))
    return false;

  const cellPos = transaction.mapping.map(shape.cell, -1);
  const cell = transaction.doc.nodeAt(cellPos);
  const role = cell ? tableRole(cell) : undefined;
  if (!cell || (role !== "cell" && role !== "header_cell")) return false;
  // Assoc -1 keeps an insertion at `pos` from pushing the start past its own content.
  const start = transaction.mapping.map(pos, -1);
  let end = start;
  transaction.mapping.maps.at(-1)?.forEach((_from, _to, _newFrom, newTo) => {
    end = newTo;
  });
  return start >= cellPos + 1 && end <= cellPos + 1 + cell.content.size;
}
