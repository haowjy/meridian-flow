/**
 * Turning a pointer into a place in the table, and a place in the table into
 * chrome geometry.
 *
 * The kernel resolves document positions; making DOM out of them is the lane's
 * job, and for a table that is the whole trick. Grips live OUTSIDE the frame
 * (Q6), so they are measured from the hovered cell and the table's own box,
 * portalled clear of the manuscript. Nothing here renders inside the table, and
 * nothing here can shift a line of text.
 *
 * **Placement is in the manuscript overlay's coordinates**
 * (`features/editor/chrome/manuscript-overlay.ts`), which is what makes a grip
 * a label on its row rather than a thing that chases it. Measured against the
 * viewport, every number here changed on every scroll and could only be
 * corrected a frame later, so a fast scroll drew the grip beside a row three
 * away from the pointer's. In the overlay these numbers do not change when the
 * pane scrolls at all: the pane carries the chrome with the row and clips
 * whatever has left it.
 *
 * Placement is a pure function of three rectangles, so where every piece goes
 * is decided in one testable place. `table-chrome.css` keeps the look; every
 * number that decides a position is here.
 *
 * **Elements are geometry, holds are identity.** A cell element is what the
 * grips are measured from and never what says which cell they serve: the chrome
 * is up while collaborators write, and every remote change rebuilds the
 * document. `cellDocPosition` and `cellElementAt` are the two crossings, and
 * what the surface keeps between them is a hold (`core/editor/anchors.ts`).
 */

import { cellAround } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";

import { overlayRect, overlayViewport } from "../../chrome/manuscript-overlay";

/** Painted sizes, matching mockup 05. */
const GRIP_LONG = 30;
const GRIP_SHORT = 15;
const ADD_TAB = 18;
/** Gaps between the frame and the chrome hovering beside it. */
const COLUMN_GRIP_GAP = 4;
const ROW_GRIP_GAP = 6;
const ADD_TAB_GAP = 9;
/**
 * The add-row tab hangs INSIDE the bottom edge rather than below it.
 *
 * Below it, the tab does not fit. All that separates two blocks is
 * `.ProseMirror > * + *`, which is `0.9em` — 14.4px at the reading size and
 * less at a smaller one — while the tab is 18px. Drawn in that seam it reached
 * into the paragraph under the table (measured: tab to 1092.6, that
 * paragraph's first line box from 1083), so a writer clicking their own first
 * line pressed "add a row", and a click meant to place a caret changed the
 * document. Shrinking the gap cannot fix a tab taller than the seam, so it
 * moves inside — ruling 8's inside-corner physics, the same trade every object
 * overlay in this editor already makes. Mockup 05 draws it below; the
 * constraint wins (human ruling, 2026-07-29).
 *
 * Sideways there is nothing to reach into. A table is a block, so the space
 * beside it is the page gutter or the table's own empty half, and the
 * add-column tab keeps its gap.
 */
const ADD_TAB_INSET = 6;

/**
 * A rectangle, in whichever space its caller is working in. Placement is in
 * overlay coordinates; the hover zone is in the pointer's own viewport ones,
 * because a pointer event is the only thing it is ever compared against.
 */
export type Box = { left: number; top: number; right: number; bottom: number };

/**
 * How far past each edge of the frame this lane's chrome reaches.
 *
 * Derived from the placements below rather than chosen: each piece is drawn in
 * the band on its own side, so a band is that side's gap plus that piece's
 * size, and the hover zone covers every piece by construction.
 *
 * Below the frame nothing is placed on purpose. What still reaches there is a
 * row grip centred on a last row shorter than the grip itself, which overhangs
 * by at most half the grip — so that is the band, and it stays inside the
 * 14.4px seam a table shares with the paragraph under it.
 */
const CHROME_BAND = {
  top: COLUMN_GRIP_GAP + GRIP_SHORT,
  left: ROW_GRIP_GAP + GRIP_SHORT,
  right: ADD_TAB_GAP + ADD_TAB,
  bottom: GRIP_LONG / 2,
} as const;

/** One piece of chrome, in the manuscript overlay's coordinates. */
export type TableChromePiece = { left: number; top: number; width: number; height: number };

/**
 * The four pieces.
 *
 * None of them is ever clamped or dropped for being out of the pane: they are
 * drawn IN the pane, which clips them itself, exactly and on the frame the
 * scroll lands. A piece pushed back inside would sit beside a row it does not
 * serve, and one dropped by a JavaScript test of a viewport rect is one that
 * flickers a frame after the scroll that moved it.
 */
export type TableChromeRects = {
  columnGrip: TableChromePiece;
  rowGrip: TableChromePiece;
  addColumn: TableChromePiece;
  addRow: TableChromePiece;
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

/**
 * The element drawing the cell at `pos` right now, or null when nothing is
 * drawing it — the cell is gone, or the rebuild has not reached the page yet.
 */
export function cellElementAt(view: EditorView, pos: number): HTMLElement | null {
  const dom = pos >= 0 && pos < view.state.doc.content.size ? view.nodeDOM(pos) : null;
  return dom instanceof HTMLElement ? dom : null;
}

/**
 * Where each piece of chrome goes, given the table's box and the hovered
 * column and row bands — all three in the manuscript overlay's coordinates,
 * and so is every answer.
 *
 * There is no scrollport argument because there is nothing to clip against:
 * the pane these are drawn in is the scrollport, and the document toolbar sits
 * ABOVE that pane rather than inside it. "Never cover the toolbar" is a
 * property of where the chrome lives now, not a test anything has to remember
 * to run.
 */
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

/**
 * The frame plus the bands its chrome hovers in: the surface a revealed table
 * chrome is held by, which is NOT the table's own rect.
 *
 * Chrome outside the frame (Q6) is only reachable if the pointer can travel to
 * it, and the travel leaves the frame several pixels before it arrives — the
 * gap alone dismissed the grips the writer was reaching for. The zone reveals
 * nothing: a cell does that. It only decides when a reveal is over. It stops at
 * the bottom edge, because the add-row tab is inside the frame and a zone
 * reaching under the table would hold the reveal open over the paragraph there.
 *
 * The left band stops exactly at the row grip's outer edge, 21px, because the
 * margin is shared: M9's block handle owns everything past 22 (see
 * `.context/CONTEXT.md`). Widening this side takes the handle's band with it.
 */
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

/**
 * The pointer is still on the hover surface of the table this cell belongs to
 * — over the frame, in the gap beside it, or on a grip drawn there.
 */
export function pointerHoldsTableChrome(
  cell: HTMLElement,
  clientX: number,
  clientY: number,
): boolean {
  const table = cell.closest("table");
  if (!table) return false;
  return boxHolds(tableHoverZone(boxOf(table)), clientX, clientY);
}

/**
 * Between a held cell and a freshly hit one, the reveal stays with the held
 * cell — true only for tables nested in another table's cell.
 *
 * The gap beside a NESTED table's frame is on no cell of that table, so the
 * hit test there answers with the outer cell the table is nested in: a fresh
 * hit that would re-anchor every grip to the outer table while the writer is
 * mid-travel to an inner grip. The held cell keeps the reveal while the fresh
 * cell's table CONTAINS the held cell's table and the pointer is still on the
 * held table's hover surface. Any other fresh cell wins: grips follow the
 * pointer cell to cell within one table, and hovering a nested table's cell
 * moves the reveal inward.
 *
 * Ancestry is `contains`, never a depth count, so a depth-3 hold outranks a
 * depth-2 hit and a depth-1 hit alike, for exactly as long as its own zone
 * holds the pointer.
 */
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

/**
 * Measure the chrome for a hovered cell, in `overlay`'s coordinates, or null
 * once the cell itself has left the manuscript's pane — at which point the
 * approach is over, whether or not the pointer moved.
 *
 * The visible-window test is about the TARGET, never about placement: a grip
 * whose row is halfway off the bottom of the pane is drawn and clipped like
 * the row it labels, but a row the writer has scrolled entirely past has
 * nothing left for a menu to be open on.
 */
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
