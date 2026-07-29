/**
 * Turning a pointer into a place in the table, and a place in the table into
 * chrome geometry.
 *
 * The kernel resolves document positions; making DOM out of them is the lane's
 * job, and for a table that is the whole trick. Grips live OUTSIDE the frame
 * (Q6), so they are measured from the hovered cell and the table's own box and
 * positioned by the viewport, portalled clear of the manuscript. Nothing here
 * renders inside the table, and nothing here can shift a line of text.
 */

import { cellAround } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";

/** Viewport geometry for one approach: the table, the hovered column, the hovered row. */
export type TableChromeRects = {
  table: { top: number; left: number; right: number; bottom: number };
  /** The hovered column's band, spanning whatever the hovered cell spans. */
  column: { left: number; width: number };
  /** The hovered row's band. */
  row: { top: number; height: number };
};

/** The cell the pointer is over, or null anywhere else in the manuscript. */
export function tableCellUnder(view: EditorView, target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const cell = target.closest("th, td");
  if (!(cell instanceof HTMLElement) || !view.dom.contains(cell)) return null;
  return cell;
}

/**
 * The document position immediately BEFORE the cell — the spelling
 * prosemirror-tables uses for "this cell", and what `CellSelection` takes.
 * Null once the element has left the document under the pointer.
 */
export function cellDocPosition(view: EditorView, cell: HTMLElement): number | null {
  if (!cell.isConnected || !view.dom.contains(cell)) return null;
  const inside = view.posAtDOM(cell, 0);
  if (inside < 0) return null;
  return cellAround(view.state.doc.resolve(inside))?.pos ?? null;
}

export function measureTableChrome(cell: HTMLElement): TableChromeRects | null {
  const table = cell.closest("table");
  if (!table || !cell.isConnected) return null;

  const cellBox = cell.getBoundingClientRect();
  const tableBox = table.getBoundingClientRect();
  if (tableBox.width === 0 && tableBox.height === 0) return null;

  return {
    table: {
      top: tableBox.top,
      left: tableBox.left,
      right: tableBox.right,
      bottom: tableBox.bottom,
    },
    column: { left: cellBox.left, width: cellBox.width },
    row: { top: cellBox.top, height: cellBox.height },
  };
}

export function sameTableChromeRects(
  a: TableChromeRects | null,
  b: TableChromeRects | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.table.top === b.table.top &&
    a.table.left === b.table.left &&
    a.table.right === b.table.right &&
    a.table.bottom === b.table.bottom &&
    a.column.left === b.column.left &&
    a.column.width === b.column.width &&
    a.row.top === b.row.top &&
    a.row.height === b.row.height
  );
}
