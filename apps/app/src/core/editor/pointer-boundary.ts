/**
 * Where a press that landed OUTSIDE the prose puts the caret.
 *
 * The editor pane has no click-dead margins (user call 2026-07-16): a press on
 * the page gutter, the padding below the last block, or the inert strip between
 * two blocks is caret territory. That press has no ProseMirror position of its
 * own — it is answered here, once, for every block kind alike. A lane shipping
 * a new block view adds nothing: the answer reads the object registration
 * (`objects/object-types.ts`), never a node name.
 *
 * Two rules make the answer safe, and both exist because a caret in DOM the
 * writer cannot see eats every keystroke it is given:
 *
 * 1. **An outside press never lands in an opaque object's interior.** A
 *    rendered diagram, a picture, a rule: the body stands in for text that is
 *    not on screen, so `posAtCoords` finding that hidden text is an accident of
 *    geometry, not an intention.
 * 2. **A press in the seam BETWEEN two blocks prefers prose to source.** A
 *    seam belongs to neither block, so a fence does not volunteer for it. A
 *    press ON a fence's own band (the gutter beside it) still enters it —
 *    that text is visible, and the writer is pointing at it.
 *
 * Both policies are geometry-independent, and cells hold any block now (§4 of
 * the cell addendum), so the same walk answers one level down: the bands may
 * be a CELL's children instead of the document's, and then a third rule joins
 * the two — a press inside a cell resolves inside that cell, never a
 * neighbouring cell and never the document. The cell is isolating; an answer
 * that leaves it is a wrong answer, not a nearest one.
 */

import { GapCursor } from "@tiptap/pm/gapcursor";
import type { Node as PMNode } from "@tiptap/pm/model";
import { type Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { gapCursorFits, isOpaqueObject, isSourceBlock, opaqueObjectAround } from "./objects";

/** A block's vertical extent in viewport coordinates. */
export type BlockBand = {
  /** Document position of the block itself. */
  pos: number;
  top: number;
  bottom: number;
};

/**
 * The block container whose children the bands are — a table cell, when the
 * press is inside one. The container is isolating, so every answer must stay
 * inside it: a press inside a cell never resolves to a neighbouring cell or
 * to the document (§4's cell-flavoured cousin of the no-row-children rule).
 */
export type PointerBoundaryContainer = {
  node: PMNode;
  /** Document position of the container node itself. */
  pos: number;
};

export type PointerBoundaryInput = {
  doc: PMNode;
  /** Viewport y of the press, unclamped — how far outside is the question. */
  y: number;
  /**
   * The bands of the blocks nearest the press, in document order — top-level
   * blocks, or the pressed cell's children when `container` names one. They
   * must bracket the press or the press lies past the container's end;
   * `blockBandsNear` guarantees that by centring the window on the block
   * `posAtCoords` answered with.
   */
  bands: readonly BlockBand[];
  /** What `posAtCoords` answered for the press clamped into the prose column. */
  coordsPos: number | null;
  /** Absent, the document itself is the container. */
  container?: PointerBoundaryContainer;
};

/**
 * Where the press puts the caret, or that it must not place one.
 *
 * `decline` is a real answer, not a failure: a document with no writer text
 * anywhere (one diagram, and nothing else) has nowhere safe to put a caret, and
 * leaving the selection where it stands beats inventing a position inside
 * hidden source. It is never a silent fall-through.
 */
export type PointerBoundaryDecision =
  | { kind: "place"; selection: Selection }
  | { kind: "decline"; reason: PointerBoundaryDecline };

export type PointerBoundaryDecline =
  /** Nothing measurable under the press — an empty document. */
  | "no-blocks"
  /** No block on either side of the boundary can hold a visible caret. */
  | "no-writer-text";

/** How many blocks either side of the press are measured. */
const BAND_WINDOW = 2;

/**
 * The decision for a press at viewport `(clientX, clientY)`.
 *
 * The one impure step: it reads the prose rectangle and the neighbouring block
 * rectangles, then hands pure data to `resolvePointerBoundary`. Callers
 * dispatch the selection; nothing here touches editor state.
 */
export function pointerBoundaryDecision(
  view: EditorView,
  clientX: number,
  clientY: number,
): PointerBoundaryDecision {
  const prose = view.dom.getBoundingClientRect();
  const coords = view.posAtCoords({
    left: Math.min(Math.max(clientX, prose.left + 1), prose.right - 1),
    top: Math.min(Math.max(clientY, prose.top + 1), prose.bottom - 1),
  });
  const container = cellUnderPress(view, clientX, clientY, coords?.pos ?? null);
  return resolvePointerBoundary({
    doc: view.state.doc,
    y: clientY,
    bands: blockBandsNear(view, coords?.pos ?? 0, container),
    coordsPos: coords?.pos ?? null,
    container: container ?? undefined,
  });
}

/**
 * The deepest cell the press itself is inside, or null for a top-level press.
 *
 * Both readings have to agree before a cell scopes the answer: `posAtCoords`
 * says the press's document neighbourhood is in the cell, and the cell's own
 * rectangle holds the pointer. A gutter press beside a table resolves to a
 * position inside a cell too, and scoping THAT press to the cell would trap a
 * page-margin click inside a grid the writer never touched.
 */
function cellUnderPress(
  view: EditorView,
  clientX: number,
  clientY: number,
  coordsPos: number | null,
): PointerBoundaryContainer | null {
  if (coordsPos === null) return null;
  const { doc } = view.state;
  const $pos = doc.resolve(Math.min(Math.max(coordsPos, 0), doc.content.size));

  for (let depth = $pos.depth; depth >= 1; depth -= 1) {
    const node = $pos.node(depth);
    const role = node.type.spec.tableRole;
    if (role !== "cell" && role !== "header_cell") continue;
    const dom = view.nodeDOM($pos.before(depth));
    if (!(dom instanceof Element)) continue;
    const rect = dom.getBoundingClientRect();
    const inside =
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom;
    // An outer cell can still hold a press its nested table's cell does not.
    if (inside) return { node, pos: $pos.before(depth) };
  }
  return null;
}

/** The rectangles of the container's blocks around `nearPos`, in document order. */
function blockBandsNear(
  view: EditorView,
  nearPos: number,
  container: PointerBoundaryContainer | null,
): BlockBand[] {
  const { doc } = view.state;
  const scope = boundaryScope(doc, container ?? undefined);
  if (scope.node.childCount === 0) return [];

  const centre = scopeChildIndex(doc, scope, nearPos);
  const first = Math.max(0, centre - BAND_WINDOW);
  const last = Math.min(scope.node.childCount - 1, centre + BAND_WINDOW);

  const bands: BlockBand[] = [];
  let pos = scope.start;
  for (let index = 0; index <= last; index += 1) {
    if (index >= first) {
      const dom = view.nodeDOM(pos);
      if (dom instanceof Element) {
        const rect = dom.getBoundingClientRect();
        bands.push({ pos, top: rect.top, bottom: rect.bottom });
      }
    }
    pos += scope.node.child(index).nodeSize;
  }
  return bands;
}

function scopeChildIndex(doc: PMNode, scope: Scope, pos: number): number {
  const $pos = doc.resolve(Math.min(Math.max(pos, scope.start), scope.end));
  const depth = doc.resolve(scope.start).depth;
  return Math.min($pos.index(depth), scope.node.childCount - 1);
}

/**
 * The container's interior, resolved once: which node's children the bands
 * are, and the position range no answer may leave.
 */
type Scope = { node: PMNode; start: number; end: number };

function boundaryScope(doc: PMNode, container?: PointerBoundaryContainer): Scope {
  if (!container) return { node: doc, start: 0, end: doc.content.size };
  const start = container.pos + 1;
  return { node: container.node, start, end: start + container.node.content.size };
}

/**
 * The pointer-boundary policy itself, over geometry and the document alone.
 *
 * Three sites, two policies. A press whose y falls inside a block's band — or
 * past the first/last band, which is the gutter above or below the container
 * — is a press ON that block. A press in the vertical margin between two
 * bands is a seam, and belongs to neither.
 */
export function resolvePointerBoundary({
  doc,
  y,
  bands,
  coordsPos,
  container,
}: PointerBoundaryInput): PointerBoundaryDecision {
  const scope = boundaryScope(doc, container);
  const first = bands[0];
  const last = bands.at(-1);
  if (!first || !last) return { kind: "decline", reason: "no-blocks" };

  const held =
    bands.find((band) => y >= band.top && y <= band.bottom) ??
    (y < first.top ? first : y > last.bottom ? last : null);
  if (held) return pressOnBlock(doc, scope, bands, held, y, coordsPos);

  const above = bands.filter((band) => band.bottom < y);
  const before = above.at(-1) ?? null;
  const after = bands.find((band) => band.top > y) ?? null;
  return seamDecision(doc, scope, before?.pos ?? null, after?.pos ?? null);
}

/**
 * A press the block owns: the writer pointed at this block from its margin.
 *
 * `posAtCoords` already found the line beside the pointer, so the answer is the
 * text position there — unless that text is an opaque object's hidden interior,
 * in which case the block cannot hold a caret at all and the press falls to the
 * nearer of its two edges, as a seam.
 */
function pressOnBlock(
  doc: PMNode,
  scope: Scope,
  bands: readonly BlockBand[],
  band: BlockBand,
  y: number,
  coordsPos: number | null,
): PointerBoundaryDecision {
  if (coordsPos !== null) {
    const at = doc.resolve(Math.min(Math.max(coordsPos, 0), doc.content.size));
    const near = TextSelection.near(at);
    // `near` reads the schema, not the scope: from the edge of a cell's last
    // block it happily answers with the NEXT cell's text, so a landing that
    // left the container is a wrong answer, not a nearest one.
    const inScope = near.from >= scope.start && near.from <= scope.end;
    if (near instanceof TextSelection && inScope && !opaqueObjectAround(near.$head)) {
      return { kind: "place", selection: near };
    }
  }

  // Geometry can betray the press outright: beside a cell border,
  // `posAtCoords` answers the NEIGHBOURING cell (the S6 probe watched a fence
  // cell's padding put the caret one cell over). The press is still ON this
  // block, and a block whose text is on the page takes it — at the nearer of
  // its two ends, because the line the pointer sat beside is unknowable once
  // geometry has lied. An opaque object still refuses (hidden interior), and
  // a container block still answers through the seam walk below.
  const held = doc.nodeAt(band.pos);
  if (held?.isTextblock && !isOpaqueObject(held)) {
    const pastMiddle = y >= (band.top + band.bottom) / 2;
    return placeText(doc, pastMiddle ? band.pos + 1 + held.content.size : band.pos + 1);
  }

  const index = bands.indexOf(band);
  const pastMiddle = y >= (band.top + band.bottom) / 2;
  const before = pastMiddle ? band : (bands[index - 1] ?? null);
  const after = pastMiddle ? (bands[index + 1] ?? null) : band;
  return seamDecision(doc, scope, before?.pos ?? null, after?.pos ?? null);
}

/**
 * A press in the strip between two blocks, which neither block claims.
 *
 * The following block answers first: a writer clicking under a paragraph is
 * heading down the page. Then the one above, then the gap between them when the
 * schema admits one (two pictures with nothing typeable between them). Only
 * when the whole document offers no visible caret does the press decline.
 */
function seamDecision(
  doc: PMNode,
  scope: Scope,
  beforePos: number | null,
  afterPos: number | null,
): PointerBoundaryDecision {
  const beforeNode = beforePos === null ? null : doc.nodeAt(beforePos);
  const afterNode = afterPos === null ? null : doc.nodeAt(afterPos);

  const following = afterNode && afterPos !== null ? writerTextEdge(afterNode, afterPos, 1) : null;
  if (following !== null) return placeText(doc, following);

  const preceding =
    beforeNode && beforePos !== null ? writerTextEdge(beforeNode, beforePos, -1) : null;
  if (preceding !== null) return placeText(doc, preceding);

  const boundary =
    afterPos ?? (beforePos !== null && beforeNode ? beforePos + beforeNode.nodeSize : null);
  if (boundary === null) return { kind: "decline", reason: "no-writer-text" };

  const $boundary = doc.resolve(boundary);
  if (gapCursorFits($boundary)) return { kind: "place", selection: new GapCursor($boundary) };

  // Both neighbours are source or opaque and no gap belongs between them. The
  // press still asked for a caret, so it gets the nearest one there IS —
  // forward first, matching the seam's own bias, and never past the scope: a
  // container with no visible caret anywhere declines rather than answering
  // with a neighbouring cell's text.
  const outward = nearestWriterText(scope, boundary, 1) ?? nearestWriterText(scope, boundary, -1);
  return outward === null ? { kind: "decline", reason: "no-writer-text" } : placeText(doc, outward);
}

function placeText(doc: PMNode, pos: number): PointerBoundaryDecision {
  return { kind: "place", selection: TextSelection.create(doc, pos) };
}

/**
 * The first (`1`) or last (`-1`) position inside `node` a writer can see a
 * caret in, or null when the node holds none.
 *
 * Null for three kinds: an opaque object (its body stands in for text that is
 * not on screen), a source block (visible, but a seam press prefers prose to
 * syntax), and a leaf. A container is asked of its children in press order, so
 * a table answers with its first cell and a blockquote with its first
 * paragraph.
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
function nearestWriterText(scope: Scope, boundary: number, direction: 1 | -1): number | null {
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
