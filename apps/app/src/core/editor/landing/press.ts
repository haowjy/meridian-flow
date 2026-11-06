/**
 * What a press puts the selection on, from where `landingAt` says it landed.
 *
 * A press on text belongs to the browser. This is for the presses with no text
 * under them: a margin, the gap between blocks, a cell's padding, the space
 * around a rendered diagram. It also owns the seam policy: where a caret goes
 * when the pointer is between blocks, and which neighbour wins.
 */

import { GapCursor } from "@tiptap/pm/gapcursor";
import type { Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, type Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { gapCursorFits } from "../objects/object-selection";
import { isObjectLike, isOpaqueObject, isSourceBlock } from "../objects/object-types";
import { type Child, type Geometry, isTable, landingAt, type Point } from "./point-landing";
import { viewGeometry } from "./view-geometry";

/**
 * The selection a press at `point` makes, or null when nothing there can hold
 * one. `start` confines the walk to the pressed cell.
 */
export function pressSelection(
  state: EditorState,
  point: Point,
  geometry: Geometry,
  start?: Child,
): Selection | null {
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
): Selection | null {
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

  // The nearer neighbour's line keeps the pointer's column.
  if (near && isProse(near.node)) {
    const line = lineIn(state, near, nearIsAbove, point, geometry, start);
    if (line) return line;
  }
  if (near && isTable(near.node) && gapCursorFits($seam)) return new GapCursor($seam);
  // Beside a table, source or an object, prose beats it.
  if (near && far && isProse(far.node)) {
    const line = lineIn(state, far, !nearIsAbove, point, geometry, start);
    if (line) return line;
  }
  // A fence with no prose on its other side (a document's end, a diagram, a
  // table) is the nearest text there is: the caret goes to its edge facing the
  // seam.
  for (const [fence, other] of [
    [near, far],
    [far, near],
  ] as const) {
    if (!fence?.node.isTextblock || !isSourceBlock(fence.node) || isOpaqueObject(fence.node))
      continue;
    if (other && isProse(other.node)) continue;
    return TextSelection.create(doc, fence === above ? seam - 1 : seam + 1);
  }
  if (gapCursorFits($seam)) return new GapCursor($seam);

  const scope = { node: $seam.parent, start: $seam.start() };
  const outward = nearestWriterText(scope, seam, 1) ?? nearestWriterText(scope, seam, -1);
  return outward === null ? null : TextSelection.create(doc, outward);
}

/** Text the writer reads and types into, as opposed to a table, an object or source. */
function isProse(node: PMNode): boolean {
  return !isTable(node) && !isObjectLike(node);
}

/** The line of `neighbour` nearest the seam, at the pointer's column. */
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

/**
 * `handleClick`: a click on a container's own element, which has no text under
 * it, takes the landing's selection. A caret already standing at the landing
 * stays the browser's own, which knows the line it sits on (a landing
 * dispatched at the end of a wrapped line would jump to the next line's start).
 */
export function pressOnInertTarget(view: EditorView, event: MouseEvent): boolean {
  if (event.button !== 0 || !view.editable || !isContainerElement(view, event.target)) return false;
  const selection = pressSelection(
    view.state,
    { x: event.clientX, y: event.clientY },
    viewGeometry(view),
  );
  const { selection: current } = view.state;
  const standing =
    selection instanceof TextSelection && current.empty && current.from === selection.from;
  if (selection && !standing) view.dispatch(view.state.tr.setSelection(selection));
  view.focus();
  return true;
}

/** The pane's margin (`view.dom` itself) or a container block's own element: not text, not an object. */
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

/**
 * The first (`1`) or last (`-1`) position inside `node` a writer can see a
 * caret in, or null when the node holds none.
 */
function writerTextEdge(node: PMNode, pos: number, direction: 1 | -1): number | null {
  if (isOpaqueObject(node)) return null;
  if (node.isTextblock) {
    if (isSourceBlock(node)) return null;
    return direction === 1 ? pos + 1 : pos + 1 + node.content.size;
  }
  if (node.isAtom || !node.isBlock) return null;

  let offset = pos + 1;
  const children: { node: PMNode; pos: number }[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    children.push({ node: child, pos: offset });
    offset += child.nodeSize;
  }
  if (direction === -1) children.reverse();

  for (const child of children) {
    const found = writerTextEdge(child.node, child.pos, direction);
    if (found !== null) return found;
  }
  return null;
}

/** The nearest writer text at or beyond `boundary`, scanning the scope's blocks. */
function nearestWriterText(
  scope: { node: PMNode; start: number },
  boundary: number,
  direction: 1 | -1,
): number | null {
  const blocks: { node: PMNode; pos: number }[] = [];
  let pos = scope.start;
  for (let index = 0; index < scope.node.childCount; index += 1) {
    const child = scope.node.child(index);
    if (direction === 1 ? pos >= boundary : pos < boundary) blocks.push({ node: child, pos });
    pos += child.nodeSize;
  }
  if (direction === -1) blocks.reverse();

  for (const block of blocks) {
    const found = writerTextEdge(block.node, block.pos, direction);
    if (found !== null) return found;
  }
  return null;
}
