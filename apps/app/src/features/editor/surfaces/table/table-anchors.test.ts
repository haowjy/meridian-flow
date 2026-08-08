// @vitest-environment jsdom
/**
 * Placement is the whole of "chrome belongs to what it serves". Two properties
 * carry it, and both are about the SPACE the numbers are in:
 *
 * - Scrolling the pane does not move a grip. It is measured in the pane's own
 *   coordinates, so the browser carries it with its row and there is nothing to
 *   chase — where the previous, viewport-space reading could only be corrected
 *   a frame after the scroll that invalidated it, which drew the grip beside a
 *   row several away from the pointer's for every frame of a fast scroll.
 * - Every piece lands inside the surface the hover is held by, or the writer
 *   travelling to a grip dismisses it a few pixels before they arrive.
 */
import { describe, expect, it } from "vitest";

import {
  type Box,
  measureTableChrome,
  nestedCellKeepsReveal,
  type TableChromePiece,
  tableChromePieces,
  tableHoverZone,
} from "./table-anchors";

function pieces(table: Box, row = { top: table.top, height: 40 }) {
  return tableChromePieces({ table, column: { left: table.left, width: 120 }, row });
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
    const { addRow } = pieces(table, { top: 1000, height: 40 });

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
});

describe("a grip is a label on its row, not a thing that chases it", () => {
  it("reads the same numbers however far the pane has scrolled", () => {
    const still = measureTableChrome(...paneWithTable({ scrollTop: 0 }));
    const scrolled = measureTableChrome(...paneWithTable({ scrollTop: 250 }));

    expect(still).not.toBeNull();
    expect(scrolled).toEqual(still);
  });

  it("lets go of a row the writer has scrolled entirely past", () => {
    // Not about placement — the pane clips what has left it, on the frame it
    // leaves. This is the target going away: a menu open on a row nobody can
    // see any more would aim its verbs at whatever the selection has become.
    expect(measureTableChrome(...paneWithTable({ scrollTop: 4000 }))).toBeNull();
  });
});

/** The manuscript's pane, with a table in it, at a given scroll offset. */
function paneWithTable({ scrollTop }: { scrollTop: number }): [HTMLElement, HTMLElement] {
  // Probe values from the running editor: the pane runs 264 to 920 across and
  // 102 to 577 down, and the table sits 170px into an unscrolled document.
  const pane = stubbedBox(document.createElement("div"), viewportBox(264, 102, 920, 577), {
    clientWidth: 656,
    clientHeight: 475,
    scrollTop,
  });
  const table = stubbedBox(
    document.createElement("table"),
    viewportBox(328, 272 - scrollTop, 856, 850 - scrollTop),
  );
  const cell = stubbedBox(
    document.createElement("td"),
    viewportBox(328, 394 - scrollTop, 504, 435 - scrollTop),
  );

  const row = document.createElement("tr");
  row.append(cell);
  table.append(row);
  pane.append(table);
  document.body.append(pane);
  return [pane, cell];
}

function viewportBox(left: number, top: number, right: number, bottom: number): DOMRect {
  return {
    left,
    top,
    right,
    bottom,
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  };
}

/** jsdom lays nothing out, so every box a measurement reads is stated here. */
function stubbedBox<T extends HTMLElement>(
  element: T,
  box: DOMRect,
  scroll: { clientWidth?: number; clientHeight?: number; scrollTop?: number } = {},
): T {
  element.getBoundingClientRect = () => box;
  Object.defineProperties(element, {
    clientLeft: { value: 0 },
    clientTop: { value: 0 },
    clientWidth: { value: scroll.clientWidth ?? 0 },
    clientHeight: { value: scroll.clientHeight ?? 0 },
    scrollLeft: { value: 0 },
    scrollTop: { value: scroll.scrollTop ?? 0 },
  });
  return element;
}

/** Every piece of a table's chrome, for the hover surface to be checked against. */
function everyPiece(table: Box, row: { top: number; height: number }): TableChromePiece[] {
  return Object.values(pieces(table, row));
}

function inside(zone: Box, piece: TableChromePiece): boolean {
  return (
    piece.left >= zone.left &&
    piece.top >= zone.top &&
    piece.left + piece.width <= zone.right &&
    piece.top + piece.height <= zone.bottom
  );
}

describe("a nested table's reveal against the outer cell it is drawn in", () => {
  // The bug this states: the gap beside a NESTED table's frame is on no cell
  // of that table, so the hit test there answers with the outer cell — a
  // fresh hit that re-anchored every grip to the outer table while the writer
  // was mid-travel to an inner grip. The held cell outranks that hit exactly
  // while the pointer is on the inner table's own hover surface.

  /** Outer 300..900 × 100..500, inner 430..700 × 270..400 (zone 409..727 ×
      251..415), innermost 480..650 × 300..370 (zone 459..677 × 281..385). */
  function nestedTables() {
    const outer = stubbedBox(document.createElement("table"), viewportBox(300, 100, 900, 500));
    const outerCell = document.createElement("td");
    const inner = stubbedBox(document.createElement("table"), viewportBox(430, 270, 700, 400));
    const innerCellA = document.createElement("td");
    const innerCellB = document.createElement("td");
    const innermost = stubbedBox(document.createElement("table"), viewportBox(480, 300, 650, 370));
    const innermostCell = document.createElement("td");

    appendRow(innermost, [innermostCell]);
    innerCellB.append(innermost);
    appendRow(inner, [innerCellA, innerCellB]);
    outerCell.append(inner);
    appendRow(outer, [outerCell]);
    return { outerCell, innerCellA, innerCellB, innermostCell };
  }

  function appendRow(table: HTMLElement, cells: HTMLElement[]) {
    const row = document.createElement("tr");
    row.append(...cells);
    table.append(row);
  }

  it("keeps the inner cell while the pointer is in the gap its grips hang in", () => {
    const { outerCell, innerCellA } = nestedTables();
    // Left of the inner frame (row grip's gap), above it (column grip's), and
    // right of it (add-column tab's): all outside the frame, all on the outer
    // cell, all part of the inner reveal.
    expect(nestedCellKeepsReveal(innerCellA, outerCell, 420, 330)).toBe(true);
    expect(nestedCellKeepsReveal(innerCellA, outerCell, 500, 260)).toBe(true);
    expect(nestedCellKeepsReveal(innerCellA, outerCell, 710, 330)).toBe(true);
  });

  it("concedes to the outer cell once the pointer leaves the inner zone", () => {
    const { outerCell, innerCellA } = nestedTables();
    expect(nestedCellKeepsReveal(innerCellA, outerCell, 400, 330)).toBe(false);
    expect(nestedCellKeepsReveal(innerCellA, outerCell, 500, 240)).toBe(false);
  });

  it("never outranks another cell of the same table, so grips follow the pointer", () => {
    const { innerCellA, innerCellB } = nestedTables();
    // The point is well inside the shared table's zone; the fresh cell still
    // wins, or the grips would freeze on the first cell hovered.
    expect(nestedCellKeepsReveal(innerCellA, innerCellB, 500, 330)).toBe(false);
  });

  it("never outranks a DEEPER cell, so hovering a nested table moves the reveal inward", () => {
    const { innerCellA, outerCell } = nestedTables();
    expect(nestedCellKeepsReveal(outerCell, innerCellA, 500, 330)).toBe(false);
  });

  it("outranks any ancestor, not just the parent, from any depth", () => {
    const { outerCell, innermostCell } = nestedTables();
    // Depth 3 against depth 1: held while in the innermost zone, conceded
    // one pixel past it.
    expect(nestedCellKeepsReveal(innermostCell, outerCell, 465, 330)).toBe(true);
    expect(nestedCellKeepsReveal(innermostCell, outerCell, 458, 330)).toBe(false);
  });
});

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
