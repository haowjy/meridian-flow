/**
 * Where a point in the editor lands: the one answer to "what is under the
 * pointer" for a press and a drag.
 *
 * Pure over a `Geometry` port, so the walk runs on fake boxes. It is total:
 * every point gets a landing, including a margin or the space below the last
 * block. Boxes decide everything but the character within a line, and that
 * character is clamped to the line's block, so an answer never leans into the
 * neighbouring block.
 */

import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";

import { caretInsideNodeAt } from "../objects/object-selection";
import { isObjectLike, isOpaqueObject, isSourceBlock } from "../objects/object-types";
import { snapOutOfAtom } from "./inline-snap";

export type Point = { x: number; y: number };

type Rect = { left: number; right: number; top: number; bottom: number };

export type Geometry = {
  /** The box of the node starting at `pos`. */
  rectOf(pos: number): Rect;
  /** Does the editor have focus? A blurred editor draws every diagram as a picture. */
  focused(): boolean;
  /** `posAtCoords` for a point already inside a textblock's box. */
  inlineAt(x: number, y: number): number | null;
};

export type Landing =
  /** In a writer textblock. */
  | { kind: "inline"; pos: number }
  /** Between blocks, where a textblock fits. */
  | { kind: "seam"; pos: number }
  /** Inside a real code block's text (or clamped to one where no textblock fits). */
  | { kind: "source"; pos: number };

export type Child = { node: PMNode; pos: number };

export function isTable(node: PMNode): boolean {
  return node.type.spec.tableRole === "table";
}

export function isTableCell(node: PMNode): boolean {
  const role = node.type.spec.tableRole;
  return role === "cell" || role === "header_cell";
}

/**
 * `start` is the container to walk from (a pressed cell); the default is the
 * document.
 */
export function landingAt(
  state: EditorState,
  origin: Point,
  geometry: Geometry,
  start?: Child,
): Landing {
  let container: Child = start ?? { node: state.doc, pos: -1 };
  let parent: PMNode | null = null;
  let point = origin;

  for (;;) {
    // A wide table scrolls inside its wrapper, and a cell scrolled out of view
    // must not take a margin press.
    if (isTable(container.node)) {
      const box = geometry.rectOf(container.pos);
      point = { x: clamp(origin.x, box.left, box.right), y: origin.y };
    }
    const children = childrenOf(container);
    if (children.length === 0) return { kind: "seam", pos: container.pos + 1 };

    const { hit, above, below } = isTable(container.node)
      ? { hit: nearestByDistance(children, point, geometry), above: null, below: null }
      : findByY(children, point.y, geometry);

    if (!hit) {
      // Below the document's last child.
      if (!below && container.pos === -1 && above) {
        return seamBefore(container, children, children.length, point, geometry);
      }
      // Between two children, where the container allows a seam.
      if (above && below) {
        const index = children.indexOf(below);
        if (allowsSeam(container.node, parent, index, above.node, below.node))
          return seamBefore(container, children, index, point, geometry);
      }
    }

    const child = hit ?? nearerOf(above, below, point.y, geometry);
    if (!child) return { kind: "seam", pos: container.pos + 1 };
    const rect = geometry.rectOf(child.pos);
    const index = children.indexOf(child);

    const { node } = child;
    const inside = within(rect, point);
    const showsSource =
      isSourceBlock(node) &&
      !(isOpaqueObject(node) && !caretInsideNodeAt(state, geometry.focused(), child.pos));
    if (showsSource && inside) {
      return { kind: "source", pos: clampInto(geometry.inlineAt(point.x, point.y), child) };
    }
    if (isObjectLike(node)) {
      const after = point.y >= (rect.top + rect.bottom) / 2;
      return seamBefore(container, children, after ? index + 1 : index, point, geometry);
    }
    if (node.isTextblock) {
      const x = clamp(point.x, rect.left + 1, rect.right - 1);
      const y = clamp(point.y, rect.top + 1, rect.bottom - 1);
      const at = geometry.inlineAt(x, y);
      const end = child.pos + 1 + node.content.size;
      if (at === null)
        return {
          kind: "inline",
          pos: point.y >= (rect.top + rect.bottom) / 2 ? end : child.pos + 1,
        };
      // A pointer over a chip lands on its nearer side.
      const pos = snapOutOfAtom(state.doc, clamp(at, child.pos + 1, end), point, geometry.rectOf);
      return { kind: "inline", pos };
    }
    parent = container.node;
    container = child;
  }
}

/** A table lists its cells, not its rows: a `rowspan` cell is found from the row it reaches into. */
export function childrenOf({ node, pos }: Child): Child[] {
  const start = pos + 1;
  const children: Child[] = [];
  if (isTable(node)) {
    node.forEach((row, rowOffset) => {
      const cellStart = start + rowOffset + 1;
      row.forEach((cell, cellOffset) => {
        children.push({ node: cell, pos: cellStart + cellOffset });
      });
    });
    return children;
  }
  node.forEach((child, offset) => {
    children.push({ node: child, pos: start + offset });
  });
  return children;
}

/**
 * Binary search over the children's boxes: the child holding `y`, else the
 * children just above and below it.
 */
function findByY(children: readonly Child[], y: number, geometry: Geometry) {
  let low = 0;
  let high = children.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const rect = geometry.rectOf(children[mid].pos);
    if (y > rect.bottom) low = mid + 1;
    else if (y < rect.top) high = mid - 1;
    else return { hit: children[mid], above: null, below: null };
  }
  return { hit: null, above: children[low - 1] ?? null, below: children[low] ?? null };
}

function nearestByDistance(
  children: readonly Child[],
  point: Point,
  geometry: Geometry,
): Child | null {
  let nearest: Child | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const child of children) {
    const rect = geometry.rectOf(child.pos);
    const distance = Math.hypot(
      Math.max(rect.left - point.x, 0, point.x - rect.right),
      Math.max(rect.top - point.y, 0, point.y - rect.bottom),
    );
    if (distance < best) {
      best = distance;
      nearest = child;
    }
  }
  return nearest;
}

function nearerOf(
  above: Child | null,
  below: Child | null,
  y: number,
  geometry: Geometry,
): Child | null {
  if (!above || !below) return above ?? below;
  const upper = geometry.rectOf(above.pos);
  const lower = geometry.rectOf(below.pos);
  return y - upper.bottom <= lower.top - y ? above : below;
}

/**
 * A seam is legal where the container can hold a paragraph there. Between the
 * text children of a list item it would split the item's own text (the item's
 * parent is a list: it cannot hold a paragraph and is not a table), so only a
 * neighbouring object (a figure) gets one.
 */
function allowsSeam(
  container: PMNode,
  parent: PMNode | null,
  index: number,
  above: PMNode,
  below: PMNode,
): boolean {
  const paragraph = container.type.schema.nodes.paragraph;
  if (!paragraph || !container.canReplaceWith(index, index, paragraph)) return false;
  if (
    parent &&
    !isTable(parent) &&
    !parent.canReplaceWith(parent.childCount, parent.childCount, paragraph)
  )
    return isObjectLike(above) || isObjectLike(below);
  return true;
}

/**
 * The seam before `children[index]` (the end when `index` is past the last).
 * An empty paragraph beside it takes the landing, so a seam never makes a
 * second blank line; where no textblock fits, the landing is the nearest
 * source block's text.
 */
function seamBefore(
  container: Child,
  children: readonly Child[],
  index: number,
  point: Point,
  geometry: Geometry,
): Landing {
  const before = children[index - 1] ?? null;
  const after = children[index] ?? null;
  const pos = after ? after.pos : before ? before.pos + before.node.nodeSize : container.pos + 1;

  const empty = [before, after].flatMap((child) =>
    child?.node.isTextblock && child.node.content.size === 0 && !isObjectLike(child.node)
      ? [child]
      : [],
  );
  const blank = nearerOf(empty[0] ?? null, empty[1] ?? null, point.y, geometry);
  if (blank) return { kind: "inline", pos: blank.pos + 1 };

  const paragraph = container.node.type.schema.nodes.paragraph;
  if (paragraph && container.node.canReplaceWith(index, index, paragraph))
    return { kind: "seam", pos };

  const source = [after, before].find((child) => child && isSourceBlock(child.node));
  if (!source) return { kind: "seam", pos };
  return { kind: "source", pos: clampInto(pos, source) };
}

/** A position clamped into the block's own text range; no answer takes its start. */
function clampInto(at: number | null, { node, pos }: Child): number {
  const start = pos + 1;
  const end = Math.max(start, pos + node.nodeSize - 1);
  return clamp(at ?? start, start, end);
}

function within(rect: Rect, { x, y }: Point): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), Math.max(low, high));
}
