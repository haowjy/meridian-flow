/**
 * Placement is the whole of "chrome belongs to what it serves": a grip that
 * has scrolled out of the manuscript's pane must not stay hit-testable over
 * the toolbar above it, and must not be dragged back inside to point at a row
 * it no longer sits beside.
 */
import { describe, expect, it } from "vitest";

import {
  type Box,
  type TableChromePiece,
  tableChromePieces,
  tableHoverZone,
} from "./table-anchors";

/** The manuscript's pane, with the document toolbar above it (probe values). */
const port: Box = { left: 300, top: 102, right: 900, bottom: 230 };

function pieces(table: Box, row = { top: table.top, height: 40 }) {
  return tableChromePieces({
    table,
    column: { left: table.left, width: 120 },
    row,
    port,
  });
}

describe("where the table's chrome goes", () => {
  it("hangs the grips clear of the frame they serve", () => {
    const table: Box = { left: 328, top: 140, right: 856, bottom: 190 };
    const { columnGrip, rowGrip, addColumn, addRow } = pieces(table, { top: 160, height: 40 });

    // 4px above the frame, centred on the hovered column.
    expect(columnGrip).toEqual({ left: 373, top: 121, width: 30, height: 15 });
    // 6px left of the frame, centred on the hovered row.
    expect(rowGrip).toEqual({ left: 307, top: 165, width: 15, height: 30 });
    // 9px past the right edge, centred on the frame.
    expect(addColumn).toEqual({ left: 865, top: 156, width: 18, height: 18 });
    // 6px inside the bottom edge, centred on the frame.
    expect(addRow).toEqual({ left: 583, top: 166, width: 18, height: 18 });
  });

  it("keeps the add-row tab off the paragraph under the table", () => {
    // Measured in the running editor: 16px prose, and `.ProseMirror > * + *`
    // is the only thing between two blocks — 0.9em, 14.4px here and less at a
    // smaller reading size. The tab is 18px. So no gap below the frame clears
    // the paragraph: at 9px the tab ran to 1092.6 while that paragraph's first
    // line box started at 1083, and a writer clicking their own first line
    // pressed "add a row" instead. Inside the frame is the only placement that
    // holds at every reading size.
    const table: Box = { left: 328, top: 800, right: 856, bottom: 1065 };
    const wide: Box = { left: 0, top: 0, right: 1200, bottom: 1400 };
    const { addRow } = tableChromePieces({
      table,
      column: { left: table.left, width: 120 },
      row: { top: 1000, height: 40 },
      port: wide,
    });
    if (!addRow) throw new Error("a table this size has room for its tab");

    expect(addRow).toEqual({ left: 583, top: 1041, width: 18, height: 18 });
    expect(addRow.top + addRow.height).toBeLessThanOrEqual(table.bottom);
  });

  it("leaves the add-column tab outside the frame, where no block reaches", () => {
    // Sideways there is nothing to collide with. A table is a block, so the
    // space beside it is the page gutter (measured: the prose column ends at
    // 856, the pane at 920) or the table's own empty half when it is aligned
    // narrow. Nothing renders there, so this tab keeps its gap.
    const table: Box = { left: 328, top: 140, right: 856, bottom: 190 };
    expect(pieces(table, { top: 160, height: 40 }).addColumn).toEqual({
      left: 865,
      top: 156,
      width: 18,
      height: 18,
    });
  });

  it("drops a grip that scrolling pushed above the pane, toolbar and all", () => {
    // The reviewer's reproduction: scrolled until the table's top is at y=24,
    // which put the row grip at y=68 to 98 — directly over a toolbar at 72 to 96.
    const scrolled: Box = { left: 328, top: 24, right: 856, bottom: 200 };
    const { columnGrip, rowGrip } = pieces(scrolled, { top: 68, height: 30 });

    expect(columnGrip).toBeNull();
    expect(rowGrip).toBeNull();
  });

  it("keeps the pieces that still fit while dropping the ones that do not", () => {
    // A tall table whose top has scrolled out but whose hovered row has not.
    const partly: Box = { left: 328, top: 40, right: 856, bottom: 600 };
    const { columnGrip, rowGrip, addColumn, addRow } = pieces(partly, { top: 150, height: 40 });

    expect(columnGrip).toBeNull();
    expect(rowGrip).not.toBeNull();
    // Both tabs hang off table edges that are outside the pane.
    expect(addColumn).toBeNull();
    expect(addRow).toBeNull();
  });

  it("drops a grip that would sit past the pane's own edges", () => {
    const nearLeftEdge: Box = { left: 305, top: 140, right: 500, bottom: 200 };
    expect(pieces(nearLeftEdge, { top: 150, height: 40 }).rowGrip).toBeNull();

    const nearRightEdge: Box = { left: 400, top: 140, right: 895, bottom: 200 };
    expect(pieces(nearRightEdge, { top: 150, height: 40 }).addColumn).toBeNull();
  });
});

/** Every piece of a wide-open table's chrome, with nothing clipped away. */
function everyPiece(table: Box, row: { top: number; height: number }): TableChromePiece[] {
  const open: Box = { left: -1e4, top: -1e4, right: 1e4, bottom: 1e4 };
  const pieces = tableChromePieces({
    table,
    column: { left: table.left, width: 120 },
    row,
    port: open,
  });
  return Object.values(pieces).filter((piece): piece is TableChromePiece => piece !== null);
}

function inside(zone: Box, piece: TableChromePiece): boolean {
  return (
    piece.left >= zone.left &&
    piece.top >= zone.top &&
    piece.left + piece.width <= zone.right &&
    piece.top + piece.height <= zone.bottom
  );
}

describe("the surface a revealed table chrome is held by", () => {
  const table: Box = { left: 328, top: 140, right: 856, bottom: 190 };

  it("covers every piece the hover put outside the frame", () => {
    // The bug this states: chrome drawn outside the frame is unreachable if
    // the hover ends at the frame, because the pointer has to cross the gap
    // to get to it. Anything placed outside this zone dismisses itself on
    // approach, so placement and hover have to be checked against each other.
    const zone = tableHoverZone(table);
    for (const piece of everyPiece(table, { top: 160, height: 40 })) {
      expect(inside(zone, piece)).toBe(true);
    }

    // Same for a hovered band at either extreme, where the grips slide to the
    // ends of their edges.
    const tall: Box = { left: 328, top: 140, right: 856, bottom: 900 };
    for (const piece of everyPiece(tall, { top: 870, height: 30 })) {
      expect(inside(tableHoverZone(tall), piece)).toBe(true);
    }
  });

  it("takes the grips' half of the shared left margin and not the handle's", () => {
    // The ruling (M9 + this lane's `.context/CONTEXT.md`): the block handle
    // owns the margin from 22px inside the text edge outwards, the row grips
    // the 21px inside it. A hover zone reaching past 21 swallows the band the
    // handle is hovered in.
    expect(table.left - tableHoverZone(table).left).toBe(21);
  });

  it("reaches past the other three edges by exactly what is drawn there", () => {
    const zone = tableHoverZone(table);
    // The column grip: a 4px gap and a 15px pill.
    expect(table.top - zone.top).toBe(19);
    // The add-column tab: a 9px gap and an 18px circle.
    expect(zone.right - table.right).toBe(27);
    // Below the frame the add-row tab is gone, and all that still reaches there
    // is the overhang of a row grip centred on a short last row: half a grip.
    // It stays inside the 14.4px seam the table shares with the paragraph under
    // it, so holding a reveal there never fights a click aimed at that prose.
    expect(zone.bottom - table.bottom).toBe(15);
  });
});
