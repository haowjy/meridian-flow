/**
 * What a block move operates on, and every transaction that moves one.
 *
 * The movable unit is a TOP-LEVEL block: a direct child of the document. That
 * single choice is what makes the drop seams safe by construction — a seam
 * between two top-level children can never land inside a table, a figure, a
 * code fence, or a list item, so "never drop inside a protected node" is a
 * property of the geometry rather than a check somebody has to remember. The
 * handle in the margin points at the same unit, so the writer's target and the
 * drop target are one thing.
 *
 * Nested reordering (a list item among its siblings, a row inside a table) is
 * deliberately not here: rows belong to the table surface (§4, deepest owner)
 * and list items have no design yet. See `.context/FUTURE`.
 *
 * Pure over `EditorState` — every function returns a `Transaction` or a
 * reading, never dispatches. The surface beside it does the dispatching, so
 * the move itself is testable without a view.
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import type { Mappable } from "@tiptap/pm/transform";

import { anchorRange, type EditorAnchor, followAnchor } from "@/core/editor/anchors";
import { selectedObject } from "@/core/editor/objects";

export type BlockTarget = {
  node: PMNode;
  /** Position immediately before the block. */
  pos: number;
  /** Index among the document's top-level children. */
  index: number;
};

/** Which way a keyboard move goes: toward the top of the document, or the end. */
export type BlockMoveDirection = "up" | "down";

/**
 * Seam positions between top-level blocks, from the very top of the document
 * to the very end. `seams[i]` is the position before block `i`, so a document
 * with n blocks has n + 1 seams and every one of them is a legal insertion
 * point for a block.
 */
export function blockSeams(doc: PMNode): number[] {
  const seams = [0];
  let pos = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    pos += doc.child(index).nodeSize;
    seams.push(pos);
  }
  return seams;
}

/** The top-level block at `index`, or null when the index is off the document. */
export function blockAtIndex(doc: PMNode, index: number): BlockTarget | null {
  if (index < 0 || index >= doc.childCount) return null;
  let pos = 0;
  for (let before = 0; before < index; before += 1) pos += doc.child(before).nodeSize;
  return { node: doc.child(index), pos, index };
}

/**
 * The top-level block containing `pos`, however deep inside it that position
 * sits. A caret in a table cell answers with the table; a pointer resolved
 * into a list item answers with the list.
 */
export function blockAt(doc: PMNode, pos: number): BlockTarget | null {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);
  // Depth 0 is a position BETWEEN top-level blocks (a pointer in the gap, a
  // node selection on a top-level block). `index(0)` then names the block
  // after the gap, and at the very end of the document there is none.
  const index = $pos.depth === 0 ? Math.min($pos.index(0), doc.childCount - 1) : $pos.index(0);
  return blockAtIndex(doc, index);
}

/**
 * The block the writer is standing on: the one holding the caret, or the one
 * holding the selected object. An inline image answers with its paragraph —
 * the paragraph is what moves.
 */
export function blockForSelection(state: EditorState): BlockTarget | null {
  const object = selectedObject(state);
  if (object) return blockAt(state.doc, object.pos);
  return blockAt(state.doc, state.selection.$from.pos);
}

/**
 * True when the selection is inside a table's cells rather than on the table
 * itself. Alt+Arrows there move rows and columns, which belong to the table
 * surface (§4, deepest owner) — this surface declines rather than moving the
 * whole table out from under a caret that was editing one cell.
 */
export function selectionIsInsideTable(state: EditorState): boolean {
  if (selectedObject(state)) return false;
  const $pos = state.selection.$from;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const role = $pos.node(depth).type.spec.tableRole;
    if (role === "cell" || role === "header_cell") return true;
  }
  return false;
}

/**
 * A block this surface has hold of, as its two seams.
 *
 * The pair is the whole trick. A single position cannot say whether the block
 * is still there: a deleted block's anchor resolves to the seam it left behind,
 * which is where the NEXT block now starts, and chrome that trusted it would
 * point at a stranger — a menu whose Delete names the neighbour, a handle
 * beside a block the writer never approached. Both seams of a deleted block
 * land on that same seam, so a collapsed hold IS "the block went away", and a
 * block a peer typed into simply grew.
 *
 * `hold.from` is the block's position. Every position this surface keeps
 * across a transaction is one of these.
 */
export type BlockHold = EditorAnchor;

/** Take hold of the block at `pos`, so chrome can find it after a write. */
export function holdBlock(state: EditorState, pos: number): BlockHold | null {
  const target = blockAt(state.doc, pos);
  return target && anchorRange(state, { from: target.pos, to: target.pos + target.node.nodeSize });
}

/** Where the held block is now, or null when the block itself went away. */
export function followBlock(
  state: EditorState,
  hold: BlockHold,
  mapping: Mappable,
): BlockHold | null {
  const at = followAnchor(state, hold, mapping);
  if (!at || at.from >= at.to) return null;
  // A surviving position must still be a block boundary at document depth: a
  // peer who wrapped the block in something else left it somewhere this
  // surface cannot act on.
  return state.doc.resolve(at.from).depth === 0 ? at : null;
}

/**
 * Move the block at `source.index` to seam `seamIndex`. Null when the move
 * would not move anything: the seams on either side of a block are where it
 * already is, and a writer who drops a paragraph back onto its own edge has
 * asked for nothing rather than for an undo entry.
 */
export function moveBlockToSeamTransaction(
  state: EditorState,
  source: BlockTarget,
  seamIndex: number,
): Transaction | null {
  const seams = blockSeams(state.doc);
  if (seamIndex < 0 || seamIndex >= seams.length) return null;
  if (seamIndex === source.index || seamIndex === source.index + 1) return null;

  const size = source.node.nodeSize;
  const seam = seams[seamIndex];
  const tr = state.tr;
  tr.delete(source.pos, source.pos + size);
  // The seam was measured on the document before the lift, so a seam below the
  // block has shifted up by exactly the block's size.
  const landing = seam < source.pos ? seam : seam - size;
  tr.insert(landing, source.node);

  return carrySelection(state, tr, source, landing).scrollIntoView();
}

/**
 * One step up or down: over the neighbour, not merely past this block's own
 * edge. Null at the ends of the document, which is the no-op the boundary
 * asks for — the key is left unconsumed and nothing errors.
 */
export function moveBlockStepTransaction(
  state: EditorState,
  source: BlockTarget,
  direction: BlockMoveDirection,
): Transaction | null {
  const seamIndex = direction === "up" ? source.index - 1 : source.index + 2;
  return moveBlockToSeamTransaction(state, source, seamIndex);
}

/**
 * A copy of the block, immediately after it. A writer standing in the block
 * lands in the copy, because the copy is the one they are about to rewrite.
 */
export function duplicateBlockTransaction(
  state: EditorState,
  source: BlockTarget,
): Transaction | null {
  const landing = source.pos + source.node.nodeSize;
  const tr = state.tr.insert(landing, source.node);
  return carrySelection(state, tr, source, landing).scrollIntoView();
}

/**
 * Remove the block. The last block standing becomes an empty paragraph rather
 * than nothing: the schema needs a block, and a writer who deleted their only
 * paragraph still expects somewhere to type.
 */
export function deleteBlockTransaction(
  state: EditorState,
  source: BlockTarget,
): Transaction | null {
  const { doc, schema } = state;
  const end = source.pos + source.node.nodeSize;

  if (doc.childCount === 1) {
    const paragraph = schema.nodes.paragraph;
    if (!paragraph) return null;
    if (source.node.type === paragraph && source.node.content.size === 0) return null;
    const tr = state.tr.replaceWith(source.pos, end, paragraph.create());
    return tr.setSelection(TextSelection.near(tr.doc.resolve(source.pos + 1))).scrollIntoView();
  }

  const tr = state.tr.delete(source.pos, end);
  const landing = Math.min(source.pos, tr.doc.content.size);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(landing), 1)).scrollIntoView();
}

/**
 * Put the writer back where they were, on the block where it now is (§5.8:
 * "selection and any open strip travel with it"). A caret keeps its offset
 * inside the block; a selected object stays selected, which is also how a
 * moved table keeps its whole-table selection — prosemirror-tables normalizes
 * the node selection back into a `CellSelection` itself.
 */
function carrySelection(
  state: EditorState,
  tr: Transaction,
  source: BlockTarget,
  landing: number,
): Transaction {
  const { selection } = state;
  const size = source.node.nodeSize;
  const inside = selection.from >= source.pos && selection.to <= source.pos + size;
  if (!inside) return tr;

  if (selectedObject(state)) {
    const node = tr.doc.nodeAt(landing);
    if (node && NodeSelection.isSelectable(node)) {
      return tr.setSelection(NodeSelection.create(tr.doc, landing));
    }
  }

  const from = tr.doc.resolve(landing + (selection.from - source.pos));
  const to = tr.doc.resolve(landing + (selection.to - source.pos));
  return tr.setSelection(TextSelection.between(from, to));
}
