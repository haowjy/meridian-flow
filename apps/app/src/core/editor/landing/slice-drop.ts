/**
 * The slice door: text and node drags inside the editor, and text dragged in
 * from outside. A slice lands where the landing says, as PM's own drop would,
 * unless that would change a table's grid.
 */

import { t } from "@lingui/core/macro";
import { Fragment, type Node as PMNode, Slice } from "@tiptap/pm/model";
import {
  type EditorState,
  NodeSelection,
  type Selection,
  TextSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { canJoin, dropPoint } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";

import { sliceForDestination } from "../extensions/meridian-extensions";
import { landSlice } from "../extensions/nesting";
import type { DropDoor, DropPlan } from "./drop-plan";
import { isTable, isTableCell, type Landing } from "./point-landing";
import { crossesTextblocks, removeRange } from "./range-removal";

type SliceSource = {
  moved: boolean;
  /** The source selection while it is still known to this editor. */
  selection: Selection | null;
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
  return {
    moved: Boolean(dragging) && !event[copyModifier],
    selection: dragging ? (dragging.node ?? view.state.selection) : null,
  };
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
  dropped: Slice | null,
  source: SliceSource,
): DropPlan {
  const { state } = view;
  if (!dropped) return { kind: "accept", pos: landing.pos };
  const slice = sliceForDestination(dropped, state.doc.resolve(landing.pos));
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
    const transaction = state.tr;
    deleteSource(transaction, source);
    const at = transaction.mapping.map(landing.pos);
    transaction.insertText(text, at);
    transaction.setSelection(TextSelection.create(transaction.doc, at, at + text.length));
    const broken = tableRefusal(state, landing.pos, {
      transaction,
      from: at,
      to: at + text.length,
    });
    if (broken) return { kind: "refuse", hint: broken };
    return {
      kind: "accept",
      pos: landing.pos,
      commit: (target) => finish(target, transaction),
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
  if (source.selection instanceof NodeSelection) source.selection.replace(transaction);
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
  return (source.selection ?? state.selection).ranges.some(
    (range) => landing.pos >= range.$from.pos && landing.pos <= range.$to.pos,
  );
}

type BuiltDrop = { transaction: Transaction; from: number; to: number };

/**
 * The transaction one slice drop dispatches, with the range it inserts in the
 * new document, or null when it changes nothing. Follows ProseMirror's own
 * drop (move-delete, node-vs-slice insert, landing selection), except that a
 * multi-line slice is inserted as blocks at a gap in the landing line.
 */
function sliceDropTransaction(
  state: EditorState,
  pos: number,
  slice: Slice,
  source: SliceSource,
): BuiltDrop | null {
  if (invisibleBoundaryRange(source.selection)) return null;
  const transaction = state.tr;
  deleteSource(transaction, source);
  const mapped = transaction.mapping.map(pos);
  const single =
    slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1
      ? slice.content.firstChild
      : null;
  const beforeInsert = transaction.doc;
  const $mapped = transaction.doc.resolve(mapped);
  const blocks = single ? null : blocksAtLanding($mapped.parent, slice, source.selection);
  let gap = mapped;
  if (blocks && $mapped.parent.isTextblock) {
    if ($mapped.parentOffset === 0) gap = mapped - 1;
    else if ($mapped.parentOffset === $mapped.parent.content.size) gap = mapped + 1;
    else {
      transaction.split(mapped);
      gap = mapped + 1;
    }
  }
  const insertAt = transaction.steps.length;
  if (single) transaction.replaceRangeWith(gap, gap, single);
  else transaction.replaceRange(gap, gap, blocks ? landSlice(blocks.slice, $mapped) : slice);
  if (transaction.doc.eq(beforeInsert)) return null;

  let from = gap;
  let end = gap;
  transaction.mapping.maps[insertAt]?.forEach((_oldFrom, _oldTo, newFrom, newTo) => {
    from = newFrom;
    end = newTo;
  });
  if (
    blocks?.joinsTail &&
    $mapped.parent.isTextblock &&
    $mapped.parentOffset < $mapped.parent.content.size &&
    canJoin(transaction.doc, end)
  ) {
    transaction.join(end);
  }
  from = transaction.mapping.slice(insertAt + 1).map(from, 1);
  end = transaction.mapping.slice(insertAt + 1).map(end, -1);
  const $landing = transaction.doc.resolve(from);
  if (single && NodeSelection.isSelectable(single) && $landing.nodeAfter?.sameMarkup(single)) {
    transaction.setSelection(new NodeSelection($landing));
  } else {
    transaction.setSelection(TextSelection.between($landing, transaction.doc.resolve(end)));
  }
  return { transaction, from, to: end };
}

function invisibleBoundaryRange(selection: Selection | null): boolean {
  if (
    !(selection instanceof TextSelection) ||
    selection.$from.parentOffset !== selection.$from.parent.content.size ||
    selection.$to.parentOffset !== 0
  )
    return false;
  let textblocks = 0;
  let carriesLeaf = false;
  selection.$from.doc.slice(selection.from, selection.to).content.descendants((node) => {
    if (node.isTextblock) textblocks++;
    if (node.isLeaf) carriesLeaf = true;
  });
  return textblocks === 2 && !carriesLeaf;
}

type BlockSlice = { slice: Slice; joinsTail: boolean };

/** Closes a multi-line slice into blocks that can be fitted at the landing gap. */
function blocksAtLanding(
  landingBlock: PMNode,
  slice: Slice,
  selection: Selection | null,
): BlockSlice | null {
  const structure =
    selection instanceof TextSelection
      ? selection.$from.doc.slice(selection.from, selection.to)
      : slice;
  let textblocks = 0;
  structure.content.descendants((node) => {
    if (node.isTextblock) textblocks++;
  });
  if (textblocks < 2 || landingBlock.type.spec.code) return null;

  let nodes = structure.content.content.slice();
  let joinsTail = false;
  if (selection instanceof TextSelection) {
    const { $from, $to } = selection;
    if ($from.depth === 1 && $from.parent.isTextblock) {
      if ($from.parentOffset === $from.parent.content.size) nodes.shift();
      else if ($from.parentOffset > 0 && nodes[0]?.isTextblock && !isListed(nodes[0]))
        nodes[0] = retype(nodes[0], landingBlock);
    }
    if ($to.depth === 1 && $to.parent.isTextblock) {
      if ($to.parentOffset === 0) nodes.pop();
      else if (
        $to.parentOffset < $to.parent.content.size &&
        nodes.at(-1)?.isTextblock &&
        !isListed(nodes.at(-1) as PMNode)
      ) {
        nodes[nodes.length - 1] = retype(nodes.at(-1) as PMNode, landingBlock);
        joinsTail = true;
      }
    }

    const shared = $from.sharedDepth($to.pos);
    let content = Fragment.from(nodes.map(closeNode));
    for (let depth = shared; depth > 0; depth--) {
      const source = $from.node(depth);
      if (isTableCell(source)) break;
      const closed = source.type.createAndFill(source.attrs, content, source.marks);
      if (!closed) break;
      content = Fragment.from(closed);
      if (source.type.spec.group?.split(" ").includes("block")) break;
    }
    nodes = content.content.slice();
  }

  const content = Fragment.from(nodes.map(closeNode));
  if (content.size === 0) return null;
  return { slice: new Slice(content, 0, 0), joinsTail };
}

/** A list item keeps being one when part of it is dropped; only plain text takes the landing block's type. */
function isListed(node: PMNode): boolean {
  return typeof node.attrs.path === "string" && node.attrs.path.includes("-");
}

function retype(node: PMNode, landingBlock: PMNode): PMNode {
  return landingBlock.type.validContent(node.content)
    ? landingBlock.type.create(landingBlock.attrs, node.content, node.marks)
    : node;
}

function closeNode(node: PMNode): PMNode {
  if (node.isLeaf) return node;
  const content = Fragment.from(node.content.content.map(closeNode));
  return node.type.createAndFill(node.attrs, content, node.marks) ?? node;
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
