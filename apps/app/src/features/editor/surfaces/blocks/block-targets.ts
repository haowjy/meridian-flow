/**
 * What a block move operates on, and every transaction that moves one.
 *
 * The handle points at a TOP-LEVEL block: a direct child of the document. That
 * single choice is what makes the drop seams safe by construction — a seam
 * between two top-level children can never land inside a table, a figure or a
 * code fence, so "never drop inside a protected node" is a property of the
 * geometry rather than a check somebody has to remember.
 *
 * What moves is the block's run (`blockRun`): a list item with what is under
 * it (`extentOf`), any other block alone. A moved run keeps its list depth
 * where it lands, at most one level under the block above it (`moveUnder`).
 * Rows belong to the table surface (§4, deepest owner).
 *
 * Pure over `EditorState` — every function returns a `Transaction` or a
 * reading, never dispatches. The surface beside it does the dispatching, so
 * the move itself is testable without a view.
 */

import { type BlockFacts, extentOf, isBodyText, nestNodes } from "@meridian/prosemirror-schema";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { moveUnder } from "@/core/editor/extensions/nesting";
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
 * True when the node at `pos` is the whole of the top-level block that would
 * move with it (§5.8).
 *
 * A block drag moves the object's BLOCK, so the two have to be the same thing
 * for the gesture to mean what it looks like. A figure standing on its own is:
 * moving its block is moving the figure. A figure in a list item beside a
 * paragraph is not, and grabbing it would carry the whole list nobody took
 * hold of; the margin handle is still there for "move this whole line".
 *
 * Structural, and about this occurrence rather than this kind: the same rule is
 * grabbable in the manuscript and only decoration inside a quote that also
 * holds prose. Every wrapper between the node and the document has to hold
 * nothing else, so an object in a table cell answers no rather than offering
 * the whole table.
 *
 * Objects that land inline never ask: they travel by ProseMirror's own drag,
 * which carries the node itself and leaves the block where it stands.
 */
export function objectIsWholeBlock(doc: PMNode, pos: number): boolean {
  if (pos < 0 || pos > doc.content.size) return false;
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if ($pos.node(depth).childCount !== 1) return false;
  }
  return true;
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

/** The blocks that move with a block: the item it starts with what is under it, or the block alone. */
export type BlockRun = {
  /** Position before the run's first block, and after its last. */
  pos: number;
  end: number;
  /** Index range among the document's top-level children, end exclusive. */
  index: number;
  endIndex: number;
  nodes: PMNode[];
};

function topLevelFacts(doc: PMNode): BlockFacts[] {
  return nestNodes(doc.content.content);
}

export function blockRun(doc: PMNode, source: BlockTarget): BlockRun {
  const [index, endIndex] = extentOf(topLevelFacts(doc), source.index);
  const nodes = doc.content.content.slice(index, endIndex);
  const size = nodes.reduce((total, node) => total + node.nodeSize, 0);
  return { pos: source.pos, end: source.pos + size, index, endIndex, nodes };
}

/**
 * Move the block's run to seam `seamIndex`. Null when the move would not move
 * anything: the seams on either side of the run, and those inside it, are
 * where it already is, and a writer who drops a paragraph back onto its own
 * edge has asked for nothing rather than for an undo entry.
 */
export function moveBlockToSeamTransaction(
  state: EditorState,
  source: BlockTarget,
  seamIndex: number,
): Transaction | null {
  const seams = blockSeams(state.doc);
  if (seamIndex < 0 || seamIndex >= seams.length) return null;
  const run = blockRun(state.doc, source);
  if (seamIndex >= run.index && seamIndex <= run.endIndex) return null;

  const above = seamIndex > 0 ? state.doc.child(seamIndex - 1) : null;
  const moved = moveUnder(run.nodes, above);
  const size = run.end - run.pos;
  const seam = seams[seamIndex];
  const tr = state.tr;
  tr.delete(run.pos, run.end);
  // The seam was measured on the document before the lift, so a seam below the
  // run has shifted up by exactly the run's size.
  const landing = seam < run.pos ? seam : seam - size;
  tr.insert(landing, Fragment.fromArray(moved));

  return carrySelection(state, tr, run, landing).scrollIntoView();
}

function listDepth(facts: BlockFacts): number {
  return facts.steps.filter((step) => step.type === "list").length;
}

/** The block continues an item at this list step, rather than starting one or standing outside it. */
function continuesAt(facts: BlockFacts | undefined, level: number): boolean {
  const step = facts?.steps[level];
  return Boolean(step && step.type === "list" && !step.opens && !step.startsItem);
}

/**
 * One step up or down: over the neighbouring item with what is under it, not
 * merely past this run's own edge, so a move never takes another item's
 * children. Null at the ends of the document, which is the no-op the boundary
 * asks for — the key is left unconsumed and nothing errors.
 */
export function moveBlockStepTransaction(
  state: EditorState,
  source: BlockTarget,
  direction: BlockMoveDirection,
): Transaction | null {
  const facts = topLevelFacts(state.doc);
  const run = blockRun(state.doc, source);
  // The list step the neighbouring item is read at: this run's own, or the outermost for a block in no list.
  const level = Math.max(listDepth(facts[run.index]), 1) - 1;
  if (direction === "up") {
    if (run.index === 0) return null;
    let start = run.index - 1;
    while (start > 0 && continuesAt(facts[start], level)) start--;
    return moveBlockToSeamTransaction(state, source, start);
  }
  if (run.endIndex >= facts.length) return null;
  let end = run.endIndex + 1;
  while (end < facts.length && continuesAt(facts[end], level)) end++;
  return moveBlockToSeamTransaction(state, source, end);
}

/**
 * A copy of the block's run, immediately after it. A writer standing in the
 * block lands in the copy, because the copy is the one they are about to rewrite.
 */
export function duplicateBlockTransaction(
  state: EditorState,
  source: BlockTarget,
): Transaction | null {
  const run = blockRun(state.doc, source);
  const copy = moveUnder(run.nodes, run.nodes[run.nodes.length - 1]);
  const tr = state.tr.insert(run.end, Fragment.fromArray(copy));
  return carrySelection(state, tr, run, run.end).scrollIntoView();
}

/**
 * Remove the block's run. A document left with nothing becomes an empty
 * paragraph rather than nothing: the schema needs a block, and a writer who
 * deleted their only paragraph still expects somewhere to type.
 */
export function deleteBlockTransaction(
  state: EditorState,
  source: BlockTarget,
): Transaction | null {
  const { doc, schema } = state;
  const run = blockRun(doc, source);

  if (run.index === 0 && run.endIndex === doc.childCount) {
    const paragraph = schema.nodes.paragraph;
    if (!paragraph) return null;
    const only = run.nodes.length === 1 ? run.nodes[0] : null;
    // An empty heading or item is not "already empty": deleting it leaves body text.
    if (only && isBodyText(only) && only.content.size === 0) return null;
    const tr = state.tr.replaceWith(run.pos, run.end, paragraph.create());
    return tr.setSelection(TextSelection.near(tr.doc.resolve(run.pos + 1))).scrollIntoView();
  }

  const tr = state.tr.delete(run.pos, run.end);
  const landing = Math.min(run.pos, tr.doc.content.size);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(landing), 1)).scrollIntoView();
}

/**
 * Put the writer back where they were, on the block where it now is (§5.8:
 * "selection and any open strip travel with it"). A caret keeps its offset
 * inside the block; a selected object stays selected, which is also how a
 * moved table keeps its whole-table selection — prosemirror-tables normalizes
 * the node selection back into a `CellSelection` itself.
 *
 * Everything held keeps its OFFSET inside the block, objects included. The
 * block travels whole, so the offset is exact — and an inline image is not its
 * block: re-selecting the landing position itself would ring the paragraph
 * that carried the picture, and the next character typed would then replace a
 * sentence the writer never selected.
 */
function carrySelection(
  state: EditorState,
  tr: Transaction,
  run: BlockRun,
  landing: number,
): Transaction {
  const { selection } = state;
  const inside = selection.from >= run.pos && selection.to <= run.end;
  if (!inside) return tr;

  const object = selectedObject(state);
  if (object) {
    const at = landing + (object.pos - run.pos);
    const node = tr.doc.nodeAt(at);
    if (node && NodeSelection.isSelectable(node)) {
      return tr.setSelection(NodeSelection.create(tr.doc, at));
    }
  }

  const from = tr.doc.resolve(landing + (selection.from - run.pos));
  const to = tr.doc.resolve(landing + (selection.to - run.pos));
  return tr.setSelection(TextSelection.between(from, to));
}
