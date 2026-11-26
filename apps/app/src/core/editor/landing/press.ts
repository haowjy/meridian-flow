import type { Editor } from "@tiptap/core";
import { GapCursor } from "@tiptap/pm/gapcursor";
import type { Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, type Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { documentEndTransaction, gapCursorFits } from "../objects/object-selection";
import { isCodeBlock, isObjectLike, isOpaqueObject, isSourceBlock } from "../objects/object-types";
import {
  type Child,
  childrenOf,
  type Geometry,
  isTable,
  landingAt,
  type Point,
} from "./point-landing";
import { viewGeometry } from "./view-geometry";

export function pressSelection(
  state: EditorState,
  point: Point,
  geometry: Geometry,
  start?: Child,
): Selection | null {
  const press = pressOutcome(state, point, geometry, start);
  return press === DOCUMENT_END ? null : press;
}

const DOCUMENT_END = "document-end";

function pressOutcome(
  state: EditorState,
  point: Point,
  geometry: Geometry,
  start?: Child,
): Selection | typeof DOCUMENT_END | null {
  const landing = landingAt(state, point, geometry, start);
  if (landing.kind === "seam") return seamSelection(state, landing.pos, point, geometry, start);
  return state.doc.resolve(landing.pos).parent.inlineContent
    ? TextSelection.create(state.doc, landing.pos)
    : null;
}

function seamSelection(
  state: EditorState,
  seam: number,
  point: Point,
  geometry: Geometry,
  start?: Child,
): Selection | typeof DOCUMENT_END | null {
  const { doc } = state;
  const $seam = doc.resolve(seam);
  const above = $seam.nodeBefore && {
    node: $seam.nodeBefore,
    pos: seam - $seam.nodeBefore.nodeSize,
  };
  const below = $seam.nodeAfter && { node: $seam.nodeAfter, pos: seam };

  const gapAbove = above ? point.y - geometry.rectOf(above.pos).bottom : Infinity;
  const gapBelow = below ? geometry.rectOf(below.pos).top - point.y : Infinity;
  const [near, far] = gapAbove <= gapBelow ? [above, below] : [below, above];
  const nearIsAbove = near === above;

  if (near && isProse(near.node)) {
    const line = lineIn(state, near, nearIsAbove, point, geometry, start);
    if (line) return line;
  }
  if (seam === doc.content.size && above && !isProse(above.node)) return DOCUMENT_END;
  if (near && isTable(near.node) && gapCursorFits($seam)) return new GapCursor($seam);
  if (near && far && isProse(far.node)) {
    const line = lineIn(state, far, !nearIsAbove, point, geometry, start);
    if (line) return line;
  }
  // A fence with no prose on its other side (a diagram, a table, a cell's
  // edge) is the nearest text there is: the caret goes to its edge facing the
  // seam.
  for (const [fence, other] of [
    [near, far],
    [far, near],
  ] as const) {
    if (!fence || !isCodeBlock(fence.node) || isOpaqueObject(fence.node)) continue;
    if (other && isProse(other.node)) continue;
    return TextSelection.create(doc, fence === above ? seam - 1 : seam + 1);
  }
  if (gapCursorFits($seam)) return new GapCursor($seam);

  const scope = { node: $seam.parent, start: $seam.start() };
  const outward = nearestWriterText(scope, seam, 1) ?? nearestWriterText(scope, seam, -1);
  return outward === null ? null : TextSelection.create(doc, outward);
}

function isProse(node: PMNode): boolean {
  return !isTable(node) && !isObjectLike(node);
}

function lineIn(
  state: EditorState,
  neighbour: Child,
  seamIsBelow: boolean,
  point: Point,
  geometry: Geometry,
  start?: Child,
): Selection | null {
  const rect = geometry.rectOf(neighbour.pos);
  const y = seamIsBelow ? rect.bottom - 1 : rect.top + 1;
  const landing = landingAt(state, { x: point.x, y }, geometry, start);
  return landing.kind === "inline" ? TextSelection.create(state.doc, landing.pos) : null;
}

export function pressOnInertTarget(view: EditorView, editor: Editor, event: MouseEvent): boolean {
  if (event.button !== 0 || !view.editable || !isContainerElement(view, event.target)) return false;
  const press = pressOutcome(
    view.state,
    { x: event.clientX, y: event.clientY },
    viewGeometry(view, editor),
  );
  if (press === DOCUMENT_END) {
    const transaction = documentEndTransaction(view.state);
    if (transaction) view.dispatch(transaction);
    view.focus();
    return true;
  }
  const selection = press;
  const { selection: current } = view.state;
  const standing =
    selection instanceof TextSelection && current.empty && current.from === selection.from;
  if (selection && !standing) view.dispatch(view.state.tr.setSelection(selection));
  view.focus();
  return true;
}

function isContainerElement(view: EditorView, target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !view.dom.contains(target)) return false;
  if (target === view.dom) return true;
  let inside: number;
  try {
    inside = view.posAtDOM(target, 0);
  } catch {
    return false;
  }
  const { parent } = view.state.doc.resolve(inside);
  return parent.isBlock && !parent.isTextblock && !parent.isAtom && !isObjectLike(parent);
}

function writerTextEdge(node: PMNode, pos: number, direction: 1 | -1): number | null {
  if (isOpaqueObject(node)) return null;
  if (node.isTextblock) {
    if (isSourceBlock(node)) return null;
    return direction === 1 ? pos + 1 : pos + 1 + node.content.size;
  }
  if (node.isAtom || !node.isBlock) return null;

  const children = childrenOf({ node, pos });
  if (direction === -1) children.reverse();

  for (const child of children) {
    const found = writerTextEdge(child.node, child.pos, direction);
    if (found !== null) return found;
  }
  return null;
}

function nearestWriterText(
  scope: { node: PMNode; start: number },
  boundary: number,
  direction: 1 | -1,
): number | null {
  const blocks = childrenOf({ node: scope.node, pos: scope.start - 1 }).filter(({ pos }) =>
    direction === 1 ? pos >= boundary : pos < boundary,
  );
  if (direction === -1) blocks.reverse();

  for (const block of blocks) {
    const found = writerTextEdge(block.node, block.pos, direction);
    if (found !== null) return found;
  }
  return null;
}
