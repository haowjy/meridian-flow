// @vitest-environment jsdom
/**
 * The verb matrix is the contract law 5 rests on: every refusal has a named
 * reason, and no verb advertises what dispatch would refuse. These cases walk
 * the table states a writer actually reaches — header on and off, a merged
 * cell, the edges — and assert the reason, not just the refusal.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { hasHeaderRow } from "@/core/editor/table-operations";

import {
  runTableVerb,
  selectedColumnAlignment,
  selectTableAxis,
  tableVerbStates,
} from "./table-commands";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent =>
  text === "" ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text }] };

function cell(type: "table_header" | "table_cell", text: string): JSONContent {
  return { type, attrs: {}, content: [paragraph(text)] };
}

/** Header H1 H2 over body rows A and B: the shape every case starts from. */
function mount(
  rows: string[][] = [
    ["A1", "A2"],
    ["B1", "B2"],
  ],
) {
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "table_row",
              content: [cell("table_header", "H1"), cell("table_header", "H2")],
            },
            ...rows.map((texts) => ({
              type: "table_row",
              content: texts.map((text) => cell("table_cell", text)),
            })),
          ],
        },
        paragraph("after"),
      ],
    },
  });
  return editor;
}

function cellPosition(current: Editor, text: string) {
  let position = -1;
  current.state.doc.descendants((node, pos) => {
    if (
      (node.type.spec.tableRole === "cell" || node.type.spec.tableRole === "header_cell") &&
      node.textContent === text
    ) {
      position = pos;
    }
  });
  expect(position).toBeGreaterThanOrEqual(0);
  return position;
}

function caretIn(current: Editor, text: string) {
  current.commands.setTextSelection(cellPosition(current, text) + 2);
}

function selectCells(current: Editor, anchor: string | number, head: string | number) {
  const at = (cell: string | number) =>
    typeof cell === "number" ? cell : cellPosition(current, cell);
  current.view.dispatch(
    current.state.tr.setSelection(CellSelection.create(current.state.doc, at(anchor), at(head))),
  );
}

const states = (current: Editor, options?: { editable?: boolean }) =>
  tableVerbStates(current.state, options);

/** The position before the cell at a grid coordinate, spans aside. */
function cellPositionAt(current: Editor, row: number, column: number) {
  const table = tableNode(current);
  let pos = 1;
  for (let index = 0; index < row; index += 1) pos += table.child(index).nodeSize;
  pos += 1;
  const rowNode = table.child(row);
  for (let index = 0; index < column; index += 1) pos += rowNode.child(index).nodeSize;
  return pos;
}

function tableNode(current: Editor) {
  const table = current.state.doc.firstChild;
  if (!table) throw new Error("table is missing");
  return table;
}

function rowText(current: Editor): string[][] {
  const table = current.state.doc.firstChild;
  if (!table) return [];
  return Array.from({ length: table.childCount }, (_, row) =>
    Array.from(
      { length: table.child(row).childCount },
      (_, column) => table.child(row).child(column).textContent,
    ),
  );
}

describe("what a table verb refuses, and why", () => {
  it("gives every verb the same reason outside a table and on a read-only document", () => {
    const current = mount();
    current.commands.setTextSelection(current.state.doc.content.size - 1);
    expect(states(current).insertRowBelow.blockedBy).toBe("no-table");
    expect(states(current).headerRow.blockedBy).toBe("no-table");

    caretIn(current, "A1");
    expect(states(current).insertRowBelow.blockedBy).toBeNull();
    expect(states(current, { editable: false }).insertRowBelow.blockedBy).toBe(
      "document-read-only",
    );
  });

  it("keeps the header row first: nothing inserts above it and it never travels", () => {
    const current = mount();
    caretIn(current, "H1");

    expect(states(current).insertRowAbove.blockedBy).toBe("header-row-first");
    expect(states(current).moveRowUp.blockedBy).toBe("header-row-first");
    expect(states(current).moveRowDown.blockedBy).toBe("header-row-first");
    expect(states(current).insertRowBelow.blockedBy).toBeNull();

    // And the first body row cannot climb over it.
    caretIn(current, "A1");
    expect(states(current).moveRowUp.blockedBy).toBe("at-table-edge");
    expect(states(current).moveRowDown.blockedBy).toBeNull();
  });

  it("frees the first row once the header is toggled off, and puts it back", () => {
    const current = mount();
    caretIn(current, "H1");
    expect(states(current).headerRow.active).toBe(true);

    runTableVerb(current, "headerRow");
    expect(hasHeaderRow(tableNode(current))).toBe(false);
    expect(states(current).headerRow.active).toBe(false);
    caretIn(current, "H1");
    expect(states(current).insertRowAbove.blockedBy).toBeNull();
    expect(states(current).moveRowDown.blockedBy).toBeNull();

    // Law 6: the same control reverses, and twice through is where it started.
    runTableVerb(current, "headerRow");
    expect(hasHeaderRow(tableNode(current))).toBe(true);
    caretIn(current, "H1");
    expect(states(current).headerRow.active).toBe(true);
    expect(states(current).insertRowAbove.blockedBy).toBe("header-row-first");
  });

  it("toggles the header ROW, not whatever rows happen to be selected", () => {
    const current = mount();
    // The whole table selected is how a writer reaches the table's own menu,
    // and the library's own toggle turns every row into a header from there.
    current.view.dispatch(
      current.state.tr.setSelection(
        CellSelection.create(
          current.state.doc,
          cellPositionAt(current, 0, 0),
          cellPositionAt(current, 2, 1),
        ),
      ),
    );
    runTableVerb(current, "headerRow");

    const table = tableNode(current);
    expect(hasHeaderRow(table)).toBe(false);
    for (let row = 0; row < table.childCount; row += 1) {
      expect(table.child(row).child(0).type.name).toBe("table_cell");
    }

    // And back on from a caret in the LAST row: the verb still names row zero.
    caretIn(current, "B2");
    runTableVerb(current, "headerRow");
    const restored = tableNode(current);
    expect(hasHeaderRow(restored)).toBe(true);
    expect(restored.child(2).child(0).type.name).toBe("table_cell");
  });

  it("names the edges rather than going quiet at them", () => {
    const current = mount();
    caretIn(current, "B1");
    expect(states(current).moveRowDown.blockedBy).toBe("at-table-edge");
    expect(states(current).moveColumnLeft.blockedBy).toBe("at-table-edge");
    expect(states(current).moveColumnRight.blockedBy).toBeNull();

    caretIn(current, "B2");
    expect(states(current).moveColumnRight.blockedBy).toBe("at-table-edge");
    expect(states(current).moveColumnLeft.blockedBy).toBeNull();
  });

  it("keeps a table from losing its last row or column", () => {
    const current = mount([["A1", "A2"]]);
    caretIn(current, "A1");
    expect(states(current).deleteRow.blockedBy).toBeNull();

    runTableVerb(current, "deleteRow");
    caretIn(current, "H1");
    expect(states(current).deleteRow.blockedBy).toBe("single-row");

    // Deleting the column takes H1 with it; H2's column is the last one left.
    runTableVerb(current, "deleteColumn");
    caretIn(current, "H2");
    expect(states(current).deleteColumn.blockedBy).toBe("single-column");
  });
});

describe("merge and split", () => {
  it("refuses a merge of one cell and offers it for a rectangle", () => {
    const current = mount();
    caretIn(current, "A1");
    expect(states(current).mergeCells.blockedBy).toBe("one-cell-selected");
    expect(states(current).splitCell.blockedBy).toBe("not-merged");

    selectCells(current, "A1", "A2");
    expect(states(current).mergeCells.blockedBy).toBeNull();
  });

  it("makes a section row out of a merged row, and splits it back", () => {
    const current = mount([
      ["Attributes", ""],
      ["B1", "B2"],
    ]);
    current.view.dispatch(
      current.state.tr.setSelection(
        CellSelection.create(
          current.state.doc,
          cellPositionAt(current, 1, 0),
          cellPositionAt(current, 1, 1),
        ),
      ),
    );
    expect(runTableVerb(current, "mergeCells")).toBe(true);

    const merged = tableNode(current).child(1);
    expect(merged.childCount).toBe(1);
    expect(merged.child(0).attrs.colspan).toBe(2);
    // A section row keeps its one label: nothing was joined onto it.
    expect(merged.textContent).toBe("Attributes");

    expect(states(current).splitCell.blockedBy).toBeNull();
    expect(states(current).mergeCells.blockedBy).toBe("one-cell-selected");

    expect(runTableVerb(current, "splitCell")).toBe(true);
    expect(tableNode(current).child(1).childCount).toBe(2);
  });

  it("keeps both cells' text when two filled cells merge", () => {
    const current = mount();
    selectCells(current, "A1", "A2");
    expect(runTableVerb(current, "mergeCells")).toBe(true);

    // A one-paragraph cell schema fits the second paragraph by splitting the
    // cell into a new row and eating its text; the join is what prevents it.
    expect(rowText(current)).toEqual([["H1", "H2"], ["A1 A2"], ["B1", "B2"]]);
    expect(tableNode(current).childCount).toBe(3);
  });

  it("refuses to swallow the header row into the body of a column", () => {
    const current = mount();
    // What a column grip selects on a headed table. Upstream would merge it
    // and keep the first cell's type: one `th` spanning the whole column, and
    // a table that no longer has a header ROW.
    selectTableAxis(current, cellPositionAt(current, 0, 0), "column");
    expect(states(current).mergeCells.blockedBy).toBe("header-and-body");
    expect(runTableVerb(current, "mergeCells")).toBe(false);
    expect(tableNode(current).childCount).toBe(3);

    // The header row on its own still merges: that is a title row.
    selectTableAxis(current, cellPositionAt(current, 0, 0), "row");
    expect(states(current).mergeCells.blockedBy).toBeNull();

    // And a column merges once there is no header row to swallow.
    runTableVerb(current, "headerRow");
    selectTableAxis(current, cellPositionAt(current, 0, 0), "column");
    expect(states(current).mergeCells.blockedBy).toBeNull();
  });

  it("keeps a hard break and an inline image, which carry no text at all", () => {
    const current = mount();
    // A cell whose only content is a hard break reads as empty to
    // `textContent` and as FILLED to prosemirror-tables. Disagreeing with the
    // library is how the break ends up ejected into a new paragraph.
    const breakCell = cellPositionAt(current, 1, 1);
    current.view.dispatch(
      current.state.tr.replaceWith(
        breakCell + 2,
        breakCell + 2 + 2,
        current.state.schema.nodes.hard_break.create(),
      ),
    );
    selectCells(current, "A1", cellPositionAt(current, 1, 1));
    expect(runTableVerb(current, "mergeCells")).toBe(true);

    const merged = tableNode(current).child(1).child(0);
    expect(merged.attrs.colspan).toBe(2);
    // "A1" and the joining space coalesce into one text node, then the break.
    expect(merged.child(0).lastChild?.type.name).toBe("hard_break");
    expect(merged.child(0).textContent).toBe("A1 ");
    // Nothing was pushed out of the table on the way.
    expect(current.state.doc.childCount).toBe(2);
  });

  it("carries every paragraph of a cell into the join, in reading order", () => {
    const current = mount();
    selectCells(current, "A1", "A2");
    runTableVerb(current, "mergeCells");
    selectCells(current, "B1", "B2");
    runTableVerb(current, "mergeCells");

    const table = tableNode(current);
    expect(table.child(1).child(0).textContent).toBe("A1 A2");
    expect(table.child(2).child(0).textContent).toBe("B1 B2");
    expect(current.state.doc.childCount).toBe(2);
  });

  it("does not claim a merged cell is unmerged when several cells are selected", () => {
    const current = mount([
      ["A1", "A2"],
      ["B1", "B2"],
    ]);
    selectCells(current, "A1", "A2");
    runTableVerb(current, "mergeCells");

    // The section row plus the row under it: upstream refuses because it is
    // more than one cell, not because nothing here is merged.
    selectCells(current, cellPositionAt(current, 1, 0), cellPositionAt(current, 2, 1));
    expect(states(current).splitCell.blockedBy).toBe("many-cells-selected");

    selectCells(current, cellPositionAt(current, 1, 0), cellPositionAt(current, 1, 0));
    expect(states(current).splitCell.blockedBy).toBeNull();
  });

  it("holds row and column moves still while any cell is merged, with the reason", () => {
    const current = mount([
      ["A1", "A2"],
      ["B1", "B2"],
      ["C1", "C2"],
    ]);
    selectCells(current, "A1", "A2");
    runTableVerb(current, "mergeCells");

    caretIn(current, "B1");
    expect(states(current).moveRowUp.blockedBy).toBe("merged-cells");
    expect(states(current).moveRowDown.blockedBy).toBe("merged-cells");
    expect(states(current).moveColumnRight.blockedBy).toBe("merged-cells");
    // Inserting is still safe around a span, so it stays live.
    expect(states(current).insertRowBelow.blockedBy).toBeNull();
    expect(states(current).deleteRow.blockedBy).toBeNull();
  });
});

describe("column alignment", () => {
  it("reports unset as unset, and reflects what a whole column carries", () => {
    const current = mount();
    caretIn(current, "A2");
    expect(selectedColumnAlignment(current.state)).toBeNull();
    expect(states(current).alignCenter.active).toBe(false);

    runTableVerb(current, "alignCenter");
    caretIn(current, "A2");
    expect(selectedColumnAlignment(current.state)).toBe("center");
    expect(states(current).alignCenter.active).toBe(true);
    expect(states(current).alignLeft.active).toBe(false);

    // The other column is untouched, so a selection across both is mixed.
    selectCells(current, "H1", "A2");
    expect(selectedColumnAlignment(current.state)).toBeNull();
  });

  it("carries a column's alignment into a row inserted under it", () => {
    const current = mount();
    caretIn(current, "A2");
    runTableVerb(current, "alignRight");
    caretIn(current, "A1");
    runTableVerb(current, "insertRowBelow");

    const inserted = current.state.doc.firstChild?.child(2);
    expect(inserted?.child(0).attrs.alignment).toBeNull();
    expect(inserted?.child(1).attrs.alignment).toBe("right");
  });
});

describe("moves the writer can reach", () => {
  it("moves a row and a column and leaves the caret on what moved", () => {
    const current = mount();
    caretIn(current, "B1");
    expect(runTableVerb(current, "moveRowUp")).toBe(true);
    expect(rowText(current)).toEqual([
      ["H1", "H2"],
      ["B1", "B2"],
      ["A1", "A2"],
    ]);

    caretIn(current, "B2");
    expect(runTableVerb(current, "moveColumnLeft")).toBe(true);
    expect(rowText(current)[0]).toEqual(["H2", "H1"]);
  });

  it("resets column widths only while there is a width to reset", () => {
    const current = mount();
    caretIn(current, "A1");
    expect(states(current).resetColumnWidths.blockedBy).toBe("no-column-widths");

    const cellPos = cellPosition(current, "A1");
    const node = current.state.doc.nodeAt(cellPos);
    if (!node) throw new Error("cell is missing");
    current.view.dispatch(
      current.state.tr.setNodeMarkup(cellPos, undefined, { ...node.attrs, colwidth: [220] }),
    );
    caretIn(current, "A1");
    expect(states(current).resetColumnWidths.blockedBy).toBeNull();

    runTableVerb(current, "resetColumnWidths");
    caretIn(current, "A1");
    expect(states(current).resetColumnWidths.blockedBy).toBe("no-column-widths");
  });

  it("reflects and reverses the table's placement in the measure", () => {
    const current = mount();
    caretIn(current, "A1");
    expect(states(current).placeLeft.active).toBe(true);

    runTableVerb(current, "placeCenter");
    caretIn(current, "A1");
    expect(states(current).placeCenter.active).toBe(true);
    expect(current.state.doc.firstChild?.attrs.align).toBe("center");

    runTableVerb(current, "placeLeft");
    caretIn(current, "A1");
    expect(states(current).placeLeft.active).toBe(true);
    expect(current.state.doc.firstChild?.attrs.align).toBeNull();
  });
});
