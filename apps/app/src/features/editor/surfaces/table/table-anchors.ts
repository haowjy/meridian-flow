import { cellAround } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";

import { overlayRect, overlayViewport } from "../../chrome/manuscript-overlay";

const GRIP_LONG = 30;
const GRIP_SHORT = 15;
const ADD_TAB = 18;
const COLUMN_GRIP_GAP = 4;
const ROW_GRIP_GAP = 6;
const ADD_TAB_GAP = 9;
const ADD_TAB_INSET = 6;

export type Box = { left: number; top: number; right: number; bottom: number };

const CHROME_BAND = {
  top: COLUMN_GRIP_GAP + GRIP_SHORT,
  left: ROW_GRIP_GAP + GRIP_SHORT,
  right: ADD_TAB_GAP + ADD_TAB,
  bottom: GRIP_LONG / 2,
} as const;

export type TableChromePiece = { left: number; top: number; width: number; height: number };

export type TableChromeRects = {
  columnGrip: TableChromePiece;
  rowGrip: TableChromePiece;
  addColumn: TableChromePiece;
  addRow: TableChromePiece;
};

export function tableCellUnder(view: EditorView, target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const cell = target.closest("th, td");
  if (!(cell instanceof HTMLElement) || !view.dom.contains(cell)) return null;
  return cell;
}

export function cellDocPosition(view: EditorView, cell: HTMLElement): number | null {
  if (!cell.isConnected || !view.dom.contains(cell)) return null;
  const inside = view.posAtDOM(cell, 0);
  if (inside < 0) return null;
  return cellAround(view.state.doc.resolve(inside))?.pos ?? null;
}

export function cellElementAt(view: EditorView, pos: number): HTMLElement | null {
  const dom = pos >= 0 && pos < view.state.doc.content.size ? view.nodeDOM(pos) : null;
  return dom instanceof HTMLElement ? dom : null;
}

export function tableChromePieces({
  table,
  column,
  row,
}: {
  table: Box;
  column: { left: number; width: number };
  row: { top: number; height: number };
}): TableChromeRects {
  return {
    columnGrip: {
      left: column.left + column.width / 2 - GRIP_LONG / 2,
      top: table.top - COLUMN_GRIP_GAP - GRIP_SHORT,
      width: GRIP_LONG,
      height: GRIP_SHORT,
    },
    rowGrip: {
      left: table.left - ROW_GRIP_GAP - GRIP_SHORT,
      top: row.top + row.height / 2 - GRIP_LONG / 2,
      width: GRIP_SHORT,
      height: GRIP_LONG,
    },
    addColumn: {
      left: table.right + ADD_TAB_GAP,
      top: (table.top + table.bottom) / 2 - ADD_TAB / 2,
      width: ADD_TAB,
      height: ADD_TAB,
    },
    addRow: {
      left: (table.left + table.right) / 2 - ADD_TAB / 2,
      top: table.bottom - ADD_TAB - ADD_TAB_INSET,
      width: ADD_TAB,
      height: ADD_TAB,
    },
  };
}

export function tableHoverZone(table: Box): Box {
  return {
    left: table.left - CHROME_BAND.left,
    top: table.top - CHROME_BAND.top,
    right: table.right + CHROME_BAND.right,
    bottom: table.bottom + CHROME_BAND.bottom,
  };
}

function boxHolds(box: Box, clientX: number, clientY: number): boolean {
  return clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom;
}

export function pointerHoldsTableChrome(
  cell: HTMLElement,
  clientX: number,
  clientY: number,
): boolean {
  const table = cell.closest("table");
  if (!table) return false;
  return boxHolds(tableHoverZone(boxOf(table)), clientX, clientY);
}

export function nestedCellKeepsReveal(
  heldCell: HTMLElement,
  hitCell: HTMLElement,
  clientX: number,
  clientY: number,
): boolean {
  const heldTable = heldCell.closest("table");
  const hitTable = hitCell.closest("table");
  if (!heldTable || !hitTable || hitTable === heldTable) return false;
  if (!hitTable.contains(heldTable)) return false;
  return pointerHoldsTableChrome(heldCell, clientX, clientY);
}

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

export function measureTableChrome(
  overlay: HTMLElement,
  cell: HTMLElement,
): TableChromeRects | null {
  const table = cell.closest("table");
  if (!table) return null;

  const tableBox = overlayRect(overlay, table);
  const cellBox = overlayRect(overlay, cell);
  if (!tableBox || !cellBox) return null;
  if (tableBox.right === tableBox.left && tableBox.bottom === tableBox.top) return null;
  if (!overlaps(cellBox, overlayViewport(overlay))) return null;

  return tableChromePieces({
    table: tableBox,
    column: { left: cellBox.left, width: cellBox.right - cellBox.left },
    row: { top: cellBox.top, height: cellBox.bottom - cellBox.top },
  });
}

const CHROME_PIECES = ["columnGrip", "rowGrip", "addColumn", "addRow"] as const;

export function sameTableChromeRects(
  a: TableChromeRects | null,
  b: TableChromeRects | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return CHROME_PIECES.every((name) => {
    const one = a[name];
    const other = b[name];
    return (
      one.left === other.left &&
      one.top === other.top &&
      one.width === other.width &&
      one.height === other.height
    );
  });
}
