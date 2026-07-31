/**
 * Where a drop inside a table lands.
 *
 * The only legal landing for dropped content inside a table is INSIDE a cell.
 * ProseMirror's own resolution does not know that rule: near a cell
 * border, `posAtCoords` answers a structural position (a child of the cell,
 * the row, or the table), and `dropPoint`'s wrapping pass then *approves* it by
 * inventing a `table_cell` wrapper — the drop manufactures a new cell, and
 * `fixTables` pads every other row to match. A picture dropped at a border
 * turned a 3-column table into 4.
 *
 * So a drop whose raw position is table-structural snaps into the nearest
 * cell, or refuses honestly when no cell can host it. The same
 * resolution answers the dropcursor during the drag, so the caret the writer
 * sees is the landing they get (the display is the promise). Follows the
 * pointer-boundary pattern: an impure reading gathers geometry, a pure
 * function decides.
 */

import type { Node as PMNode, Slice } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { type EditorState, NodeSelection, type Selection, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

/** One cell's document position and its rectangle in viewport coordinates. */
export type CellBand = {
  /** Position before the cell node. */
  pos: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
};

export type TableDropInput = {
  doc: PMNode;
  /** What `posAtCoords` answered for the drop. */
  rawPos: number;
  /** Viewport point of the drop or dragover. */
  x: number;
  y: number;
  /** Every cell of the table the position is in, in document order. */
  cells: readonly CellBand[];
};

/**
 * `default` hands the drop back to ProseMirror's own resolution — the raw
 * position is not table-structural, so the stock behavior is already legal.
 * `refuse` is a real answer, not a failure: consuming the drop and doing
 * nothing beats manufacturing a column.
 */
export type TableDropDecision =
  | { kind: "default" }
  | { kind: "snap"; pos: number }
  | { kind: "refuse" };

function tableRole(node: PMNode): string | undefined {
  return node.type.spec.tableRole as string | undefined;
}

/** Depth of the innermost `table` ancestor, or null when the position is not in one. */
function tableDepthAt(doc: PMNode, pos: number): number | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    if (tableRole($pos.node(depth)) === "table") return depth;
  }
  return null;
}

/**
 * The inline position at one edge of a cell's writer text: just inside its
 * first textblock, or at the end of its last. Null for a cell with no
 * textblock — a shape `fixTables` never produces.
 */
function inlineEdgeInCell(cell: PMNode, cellPos: number, edge: "start" | "end"): number | null {
  let found: number | null = null;
  cell.descendants((node, offset) => {
    if (!node.isTextblock) return true;
    const start = cellPos + 1 + offset + 1;
    if (edge === "start") {
      if (found === null) found = start;
      return false;
    }
    found = start + node.content.size;
    return false;
  });
  return found;
}

/** Distance from a point to a rectangle; zero inside it. */
function distanceToBand(band: CellBand, x: number, y: number): number {
  const dx = Math.max(band.left - x, 0, x - band.right);
  const dy = Math.max(band.top - y, 0, y - band.bottom);
  return Math.hypot(dx, dy);
}

/**
 * The decision for a drop at `(x, y)` that resolved to `rawPos`.
 *
 * A raw position whose parent holds inline content is a real text landing and
 * stays ProseMirror's business. Anything else inside a table is a structural
 * seam: the drop snaps into the cell under (or nearest) the pointer, at the
 * edge of its text nearest the pointer.
 */
export function resolveTableDrop({ doc, rawPos, x, y, cells }: TableDropInput): TableDropDecision {
  if (rawPos < 0 || rawPos > doc.content.size) return { kind: "default" };
  const $raw = doc.resolve(rawPos);
  if ($raw.parent.inlineContent) return { kind: "default" };
  if (tableDepthAt(doc, rawPos) === null) return { kind: "default" };

  let nearest: CellBand | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const band of cells) {
    const distance = distanceToBand(band, x, y);
    if (distance < nearestDistance) {
      nearest = band;
      nearestDistance = distance;
    }
  }
  if (!nearest) return { kind: "refuse" };

  const cell = doc.nodeAt(nearest.pos);
  if (!cell) return { kind: "refuse" };
  const edge = x <= (nearest.left + nearest.right) / 2 ? "start" : "end";
  const pos = inlineEdgeInCell(cell, nearest.pos, edge);
  return pos === null ? { kind: "refuse" } : { kind: "snap", pos };
}

/**
 * Whether a seam-snapped landing can honestly promise this slice a home.
 *
 * The answer is the actual schema fit: a shape-preserving landing transaction
 * exists, or it does not. Cells hold any block sequence now (§3b), so the
 * refusals left are structural — content whose every fit would change the
 * table's grid or spill outside the pressed cell. A null slice is a file
 * drop, whose payload becomes an inline image and always fits.
 */
export function seamHostableSlice(state: EditorState, pos: number, slice: Slice | null): boolean {
  if (!slice || slice.content.size === 0) return true;
  return seamDropTransaction(state, pos, slice, { moved: false, node: null }) !== null;
}

/** Position of the innermost cell holding `pos`, or null outside every cell. */
function cellPosAt(doc: PMNode, pos: number): number | null {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const role = tableRole($pos.node(depth));
    if (role === "cell" || role === "header_cell") return $pos.before(depth);
  }
  return null;
}

/** Row widths of the table around `pos` — the shape a drop must not change. */
function tableShapeAt(doc: PMNode, pos: number): { pos: number; rows: number[] } | null {
  const depth = tableDepthAt(doc, pos);
  if (depth === null) return null;
  const $pos = doc.resolve(pos);
  const table = $pos.node(depth);
  const rows: number[] = [];
  table.forEach((row) => {
    rows.push(row.childCount);
  });
  return { pos: $pos.before(depth), rows };
}

/**
 * The transaction one seam-snapped drop dispatches, or null when the drop must
 * refuse. Mirrors ProseMirror's own drop (move-delete, node-vs-slice insert,
 * landing selection), with two additions read back after the insert: the
 * containing table's shape must be unchanged — the column count is invariant
 * under drops, structurally — and everything inserted must stand inside the
 * pressed cell, because the fitter is free to improvise a landing beyond it
 * and a landing the dropcursor never promised is a refusal, not a surprise.
 */
export function seamDropTransaction(
  state: EditorState,
  pos: number,
  slice: Slice,
  source: {
    moved: boolean;
    /** The dragged node's own selection, when the drag carried one. */
    node: Selection | null;
  },
): Transaction | null {
  const shapeBefore = tableShapeAt(state.doc, pos);
  if (!shapeBefore) return null;
  const cellBefore = cellPosAt(state.doc, pos);
  if (cellBefore === null) return null;

  const transaction = state.tr;
  if (source.moved) {
    if (source.node) source.node.replace(transaction);
    else transaction.deleteSelection();
  }
  const mapped = transaction.mapping.map(pos);
  const single =
    slice.openStart === 0 && slice.openEnd === 0 && slice.content.childCount === 1
      ? slice.content.firstChild
      : null;
  const beforeInsert = transaction.doc;
  if (single) transaction.replaceRangeWith(mapped, mapped, single);
  else transaction.replaceRange(mapped, mapped, slice);
  if (transaction.doc.eq(beforeInsert)) return null;

  const tablePos = transaction.mapping.map(shapeBefore.pos, -1);
  const tableAfter = transaction.doc.nodeAt(tablePos);
  if (!tableAfter || tableRole(tableAfter) !== "table") return null;
  const rowsAfter: number[] = [];
  tableAfter.forEach((row) => {
    rowsAfter.push(row.childCount);
  });
  if (
    rowsAfter.length !== shapeBefore.rows.length ||
    rowsAfter.some((width, index) => width !== shapeBefore.rows[index])
  ) {
    return null;
  }

  let end = transaction.mapping.map(pos);
  const last = transaction.mapping.maps[transaction.mapping.maps.length - 1];
  last?.forEach((_from, _to, _newFrom, newTo) => {
    end = newTo;
  });

  const cellPos = transaction.mapping.map(cellBefore, -1);
  const cellAfter = transaction.doc.nodeAt(cellPos);
  const cellRole = cellAfter ? tableRole(cellAfter) : undefined;
  if (!cellAfter || (cellRole !== "cell" && cellRole !== "header_cell")) return null;
  if (mapped < cellPos + 1 || end > cellPos + 1 + cellAfter.content.size) return null;

  const $landing = transaction.doc.resolve(mapped);
  if (single && NodeSelection.isSelectable(single) && $landing.nodeAfter?.sameMarkup(single)) {
    transaction.setSelection(new NodeSelection($landing));
  } else {
    transaction.setSelection(TextSelection.between($landing, transaction.doc.resolve(end)));
  }
  transaction.setMeta("uiEvent", "drop");
  return transaction;
}

/**
 * The decision for a drop at viewport `(x, y)` — the one impure step.
 *
 * It reads what `posAtCoords` answered, and measures the table's cells only
 * when that answer is a structural seam. Both consumers go through here: the
 * drop handler and the dropcursor, which is what makes the caret during the
 * drag and the landing on release one answer.
 */
export function tableDropDecision(
  view: EditorView,
  point: { x: number; y: number },
): TableDropDecision {
  const coords = view.posAtCoords({ left: point.x, top: point.y });
  if (!coords) return { kind: "default" };
  const doc = view.state.doc;
  const $raw = doc.resolve(coords.pos);
  if ($raw.parent.inlineContent) return { kind: "default" };
  const depth = tableDepthAt(doc, coords.pos);
  if (depth === null) return { kind: "default" };
  return resolveTableDrop({
    doc,
    rawPos: coords.pos,
    x: point.x,
    y: point.y,
    cells: measureCellBands(view, $raw.before(depth)),
  });
}

/** The rectangles of every cell in the table at `tablePos`, in document order. */
function measureCellBands(view: EditorView, tablePos: number): CellBand[] {
  const table = view.state.doc.nodeAt(tablePos);
  if (!table) return [];
  const bands: CellBand[] = [];
  table.forEach((row, rowOffset) => {
    const rowStart = tablePos + 1 + rowOffset + 1;
    row.forEach((_cell, cellOffset) => {
      const cellPos = rowStart + cellOffset;
      const dom = view.nodeDOM(cellPos);
      if (!(dom instanceof HTMLElement)) return;
      const rect = dom.getBoundingClientRect();
      bands.push({
        pos: cellPos,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      });
    });
  });
  return bands;
}
