import { type BlockFacts, extentOf, isBodyText, nestNodes } from "@meridian/prosemirror-schema";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, NodeSelection, TextSelection, type Transaction } from "@tiptap/pm/state";
import { moveUnder } from "@/core/editor/extensions/nesting";
import { selectedObject } from "@/core/editor/objects";

export type BlockTarget = {
  node: PMNode;
  pos: number;
  index: number;
};

export type BlockMoveDirection = "up" | "down";

export function blockSeams(doc: PMNode): number[] {
  const seams = [0];
  let pos = 0;
  for (let index = 0; index < doc.childCount; index += 1) {
    pos += doc.child(index).nodeSize;
    seams.push(pos);
  }
  return seams;
}

export function blockAtIndex(doc: PMNode, index: number): BlockTarget | null {
  if (index < 0 || index >= doc.childCount) return null;
  let pos = 0;
  for (let before = 0; before < index; before += 1) pos += doc.child(before).nodeSize;
  return { node: doc.child(index), pos, index };
}

export function blockAt(doc: PMNode, pos: number): BlockTarget | null {
  const clamped = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(clamped);
  // Depth 0 is a position BETWEEN top-level blocks (a pointer in the gap, a
  // node selection on a top-level block). `index(0)` then names the block
  // after the gap, and at the very end of the document there is none.
  const index = $pos.depth === 0 ? Math.min($pos.index(0), doc.childCount - 1) : $pos.index(0);
  return blockAtIndex(doc, index);
}

export function objectIsWholeBlock(doc: PMNode, pos: number): boolean {
  if (pos < 0 || pos > doc.content.size) return false;
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    if ($pos.node(depth).childCount !== 1) return false;
  }
  return true;
}

export function blockForSelection(state: EditorState): BlockTarget | null {
  const object = selectedObject(state);
  if (object) return blockAt(state.doc, object.pos);
  return blockAt(state.doc, state.selection.$from.pos);
}

export function selectionIsInsideTable(state: EditorState): boolean {
  if (selectedObject(state)) return false;
  const $pos = state.selection.$from;
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const role = $pos.node(depth).type.spec.tableRole;
    if (role === "cell" || role === "header_cell") return true;
  }
  return false;
}

export type BlockRun = {
  pos: number;
  end: number;
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
  const landing = seam < run.pos ? seam : seam - size;
  tr.insert(landing, Fragment.fromArray(moved));

  return carrySelection(state, tr, run, landing).scrollIntoView();
}

function listDepth(facts: BlockFacts): number {
  return facts.steps.filter((step) => step.type === "list").length;
}

function continuesAt(facts: BlockFacts | undefined, level: number): boolean {
  const step = facts?.steps[level];
  return Boolean(step && step.type === "list" && !step.opens && !step.startsItem);
}

export function moveBlockStepTransaction(
  state: EditorState,
  source: BlockTarget,
  direction: BlockMoveDirection,
): Transaction | null {
  const facts = topLevelFacts(state.doc);
  const run = blockRun(state.doc, source);
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

export function duplicateBlockTransaction(
  state: EditorState,
  source: BlockTarget,
): Transaction | null {
  const run = blockRun(state.doc, source);
  const copy = moveUnder(run.nodes, run.nodes[run.nodes.length - 1]);
  const tr = state.tr.insert(run.end, Fragment.fromArray(copy));
  return carrySelection(state, tr, run, run.end).scrollIntoView();
}

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
    if (only && isBodyText(only) && only.content.size === 0) return null;
    const tr = state.tr.replaceWith(run.pos, run.end, paragraph.create());
    return tr.setSelection(TextSelection.near(tr.doc.resolve(run.pos + 1))).scrollIntoView();
  }

  const tr = state.tr.delete(run.pos, run.end);
  const landing = Math.min(run.pos, tr.doc.content.size);
  return tr.setSelection(TextSelection.near(tr.doc.resolve(landing), 1)).scrollIntoView();
}

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
