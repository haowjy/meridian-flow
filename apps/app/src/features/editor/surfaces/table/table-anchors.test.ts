/**
 * Placement is the whole of "chrome belongs to what it serves": a grip that
 * has scrolled out of the manuscript's pane must not stay hit-testable over
 * the toolbar above it, and must not be dragged back inside to point at a row
 * it no longer sits beside.
 */
import { describe, expect, it } from "vitest";

import { type Box, tableChromePieces } from "./table-anchors";

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
    // 9px past the right and bottom edges, centred on the frame.
    expect(addColumn).toEqual({ left: 865, top: 156, width: 18, height: 18 });
    expect(addRow).toEqual({ left: 583, top: 199, width: 18, height: 18 });
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
