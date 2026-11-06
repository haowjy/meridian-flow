/**
 * The slice door: text and node drags inside the editor, and text dragged in
 * from outside. A slice lands where the landing says, as PM's own drop would,
 * unless that would change a table's grid.
 */

import { t } from "@lingui/core/macro";
import { Fragment, type Node as PMNode, type ResolvedPos, Slice } from "@tiptap/pm/model";
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
import { crossesTextblocks, removeRange } from "./range-removal";

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
  if (source.moved && landsInMovedRange(state, landing, source)) return { kind: "refuse" };

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
    return {
      kind: "accept",
      pos: landing.pos,
      commit(target) {
        const transaction = target.state.tr;
        deleteSource(transaction, source);
        const at = transaction.mapping.map(landing.pos);
        transaction.insertText(text, at);
        transaction.setSelection(TextSelection.create(transaction.doc, at, at + text.length));
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
  if (!built) return { kind: "refuse" };
  const broken = tableRefusal(state, pos, built);
  if (broken) return { kind: "refuse", hint: broken };
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
  else if (crossesTextblocks(transaction.selection)) {
    removeRange(transaction, transaction.selection.from, transaction.selection.to);
  } else transaction.deleteSelection();
}

/**
 * True when this move lands inside the dragged range itself (its ends
 * included; for a `CellSelection`, inside any of its cells). The unselected
 * part of a block the range reaches into is an ordinary landing.
 */
function landsInMovedRange(state: EditorState, landing: Landing, source: SliceSource): boolean {
  return (source.node ?? state.selection).ranges.some(
    (range) => landing.pos >= range.$from.pos && landing.pos <= range.$to.pos,
  );
}

type BuiltDrop = { transaction: Transaction; from: number; to: number };

/**
 * The transaction one slice drop dispatches, with the range it inserts in the
 * new document, or null when it changes nothing. Follows ProseMirror's own
 * drop (move-delete, node-vs-slice insert, landing selection), except that a
 * multi-line slice breaks the line it lands in (see `breakAtLanding`).
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
  const inserted = transaction.steps.length;
  const $mapped = transaction.doc.resolve(mapped);
  const broken = single ? null : breakAtLanding($mapped, slice);
  if (single) transaction.replaceRangeWith(mapped, mapped, single);
  else transaction.replaceRange(mapped, mapped, broken ?? slice);
  if (transaction.doc.eq(beforeInsert)) return null;

  // Assoc -1 keeps an insertion at `pos` from pushing the start past its own content.
  const from = transaction.mapping.map(pos, -1);
  let end = from;
  transaction.mapping.maps.at(-1)?.forEach((_from, _to, _newFrom, newTo) => {
    end = newTo;
  });
  // Landing at a block's start leaves an empty block before the first line.
  if (broken && $mapped.parentOffset === 0) {
    transaction.delete(mapped - 1, mapped + 1);
    end = transaction.mapping.slice(inserted + 1).map(end, -1);
  }
  const $landing = transaction.doc.resolve(broken ? Math.min(mapped + 1, end) : mapped);
  if (single && NodeSelection.isSelectable(single) && $landing.nodeAfter?.sameMarkup(single)) {
    transaction.setSelection(new NodeSelection($landing));
  } else {
    transaction.setSelection(TextSelection.between($landing, transaction.doc.resolve(end)));
  }
  return { transaction, from, to: end };
}

/**
 * A slice of several lines landing inside a textblock keeps its lines: the
 * first starts its own line and the last joins what follows, both as blocks of
 * the landing's type. (A line whose end the selection cut through is retyped; a
 * block the slice carries whole keeps its type.) A leading empty block of the
 * landing's type, left open at its start, is what makes the first line a new
 * block rather than a continuation of the text before the caret. Null when the
 * slice lands whole.
 */
function breakAtLanding($landing: ResolvedPos, slice: Slice): Slice | null {
  const block = $landing.parent;
  if (!block.isTextblock || block.type.spec.code) return null;
  const retype = (line: PMNode): PMNode =>
    block.type.validContent(line.content)
      ? block.type.create(block.attrs, line.content, line.marks)
      : line;

  const blocks = slice.content.content.slice();
  const first = peelLine(blocks, 0, slice.openStart);
  const last = blocks.length > 0 ? peelLine(blocks, blocks.length - 1, slice.openEnd) : null;
  if (!first || !last) return null;
  const lines = [
    block.type.create(block.attrs),
    slice.openStart > 0 ? retype(first) : first,
    ...blocks,
    slice.openEnd > 0 ? retype(last) : last,
  ];
  return new Slice(Fragment.from(lines), 1, slice.openEnd > 0 ? 1 : 0);
}

/**
 * Takes the textblock at the end of the open edge out of `blocks[index]`,
 * leaving what remains of its ancestors (or nothing) in its place. Null, with
 * `blocks` unchanged, when the edge doesn't end in a textblock.
 */
function peelLine(blocks: PMNode[], index: number, open: number): PMNode | null {
  const atStart = index === 0;
  const peel = (node: PMNode, depth: number): { line: PMNode; rest: PMNode | null } | null => {
    if (node.isTextblock) return { line: node, rest: null };
    if (depth >= open || node.childCount === 0) return null;
    const at = atStart ? 0 : node.childCount - 1;
    const inner = peel(node.child(at), depth + 1);
    if (!inner) return null;
    const siblings: PMNode[] = [];
    node.forEach((child, _offset, i) => {
      if (i !== at) siblings.push(child);
    });
    const kept = inner.rest
      ? atStart
        ? [inner.rest, ...siblings]
        : [...siblings, inner.rest]
      : siblings;
    return { line: inner.line, rest: kept.length ? node.copy(Fragment.from(kept)) : null };
  };
  const peeled = peel(blocks[index], 0);
  if (!peeled) return null;
  if (peeled.rest) blocks[index] = peeled.rest;
  else blocks.splice(index, 1);
  return peeled.line;
}

function sameGrid(a: PMNode, b: PMNode): boolean {
  if (a.childCount !== b.childCount) return false;
  for (let row = 0; row < a.childCount; row++) {
    if (a.child(row).childCount !== b.child(row).childCount) return false;
  }
  return true;
}

/** The position of the innermost table, row or cell around `pos`, or null outside a table. */
function tablePartAround(state: EditorState, pos: number): number | null {
  const $pos = state.doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.spec.tableRole) return $pos.before(depth);
  }
  return null;
}

/**
 * Why this drop can't happen, or null when it can. A table's rows and columns
 * are fixed, so every table that survives, nested ones included, must keep its
 * grid (one whose whole range the drop deletes is gone, not changed). In a
 * cell, the drop also stays in that cell: the fitter is free to improvise a
 * landing the caret never promised.
 */
function tableRefusal(
  before: EditorState,
  pos: number,
  { transaction, from, to }: BuiltDrop,
): string | null {
  const part = tablePartAround(before, pos);
  const inCell = t`Can’t put that in a table cell`;
  let broken: string | null = null;
  before.doc.descendants((node, at) => {
    if (broken || !isTable(node)) return !broken;
    const start = transaction.mapping.mapResult(at, 1);
    const end = transaction.mapping.mapResult(at + node.nodeSize, -1);
    if (!(start.deletedAfter && end.deletedBefore)) {
      const now = transaction.doc.nodeAt(start.pos);
      if (!(now && isTable(now) && sameGrid(node, now))) {
        // A table around the landing may have broken from the insert or from
        // the move's deletion; the first reads as the drop's fault.
        broken = pos > at && pos < at + node.nodeSize ? inCell : t`Can’t move part of a table`;
      }
    }
    return !broken;
  });
  if (broken) return broken;
  if (part === null) return null;

  const cellPos = transaction.mapping.map(part, -1);
  const cell = transaction.doc.nodeAt(cellPos);
  return cell && isTableCell(cell) && from >= cellPos + 1 && to <= cellPos + 1 + cell.content.size
    ? null
    : inCell;
}
