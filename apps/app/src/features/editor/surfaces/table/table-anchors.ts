/**
 * Turning a pointer into a place in the table, and a place in the table into
 * chrome geometry.
 *
 * The kernel resolves document positions; making DOM out of them is the lane's
 * job, and for a table that is the whole trick. Grips live OUTSIDE the frame
 * (Q6), so they are measured from the hovered cell and the table's own box and
 * positioned by the viewport, portalled clear of the manuscript. Nothing here
 * renders inside the table, and nothing here can shift a line of text.
 *
 * Placement is a pure function of four rectangles, so where a piece goes and
 * whether it fits are decided in one testable place. `table-chrome.css` keeps the
 * look; every number that decides a position is here.
 */

import { cellAround } from "@tiptap/pm/tables";
import type { EditorView } from "@tiptap/pm/view";

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

/** One piece of chrome, in viewport coordinates. */
export type TableChromePiece = { left: number; top: number; width: number; height: number };

/**
 * The four pieces, each null when it would fall outside the scrollport.
 *
 * Null rather than clamped: a grip pushed back inside the port would sit
 * beside a row it does not serve, and chrome pointing at the wrong row is
 * worse than chrome that is not there. A piece that cannot reach its row does
 * not draw.
 */
export type TableChromeRects = {
  columnGrip: TableChromePiece | null;
  rowGrip: TableChromePiece | null;
  addColumn: TableChromePiece | null;
  addRow: TableChromePiece | null;
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

function fits(piece: TableChromePiece, port: Box): TableChromePiece | null {
  return piece.left >= port.left &&
    piece.top >= port.top &&
    piece.left + piece.width <= port.right &&
    piece.top + piece.height <= port.bottom
    ? piece
    : null;
}

/**
 * Where each piece of chrome goes, given the table, the hovered column band,
 * the hovered row band, and the scrollport that clips them all.
 *
 * The scrollport is the manuscript's own pane, and the document toolbar sits
 * ABOVE it rather than inside it. Clipping to the port is therefore the whole
 * of "never cover the toolbar": a grip that would ride up over it is a grip
 * that has left the port.
 */
export function tableChromePieces({
  table,
  column,
  row,
  port,
}: {
  table: Box;
  column: { left: number; width: number };
  row: { top: number; height: number };
  port: Box;
}): TableChromeRects {
  return {
    columnGrip: fits(
      {
        left: column.left + column.width / 2 - GRIP_LONG / 2,
        top: table.top - COLUMN_GRIP_GAP - GRIP_SHORT,
        width: GRIP_LONG,
        height: GRIP_SHORT,
      },
      port,
    ),
    rowGrip: fits(
      {
        left: table.left - ROW_GRIP_GAP - GRIP_SHORT,
        top: row.top + row.height / 2 - GRIP_LONG / 2,
        width: GRIP_SHORT,
        height: GRIP_LONG,
      },
      port,
    ),
    addColumn: fits(
      {
        left: table.right + ADD_TAB_GAP,
        top: (table.top + table.bottom) / 2 - ADD_TAB / 2,
        width: ADD_TAB,
        height: ADD_TAB,
      },
      port,
    ),
    addRow: fits(
      {
        left: (table.left + table.right) / 2 - ADD_TAB / 2,
        top: table.bottom - ADD_TAB - ADD_TAB_INSET,
        width: ADD_TAB,
        height: ADD_TAB,
      },
      port,
    ),
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

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function overlaps(a: Box, b: Box): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/**
 * Measure the chrome for a hovered cell, or null once the cell itself has left
 * the manuscript's pane — at which point the approach is over, whether or not
 * the pointer moved.
 */
export function measureTableChrome(cell: HTMLElement): TableChromeRects | null {
  const table = cell.closest("table");
  if (!table || !cell.isConnected) return null;

  const tableBox = boxOf(table);
  if (tableBox.right === tableBox.left && tableBox.bottom === tableBox.top) return null;

  const scroller = cell.closest("[data-stable-layout-scroll]");
  const port: Box = scroller
    ? boxOf(scroller)
    : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };

  const cellBox = boxOf(cell);
  if (!overlaps(cellBox, port)) return null;

  return tableChromePieces({
    table: tableBox,
    column: { left: cellBox.left, width: cellBox.right - cellBox.left },
    row: { top: cellBox.top, height: cellBox.bottom - cellBox.top },
    port,
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
    if (one === other) return true;
    if (!one || !other) return false;
    return (
      one.left === other.left &&
      one.top === other.top &&
      one.width === other.width &&
      one.height === other.height
    );
  });
}
