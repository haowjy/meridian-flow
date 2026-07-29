// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "./config";
import { MeridianTableView } from "./extensions/meridian-extensions";
import {
  addTableRow,
  alignTableColumn,
  moveTableColumn,
  moveTableRow,
  resetTableLayout,
  tableSelection,
} from "./table-operations";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

function cell(type: "table_header" | "table_cell", text: string, attrs = {}): JSONContent {
  return { type, attrs, content: [paragraph(text)] };
}

function tableContent(): JSONContent {
  return {
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          {
            type: "table_row",
            content: [cell("table_header", "H1"), cell("table_header", "H2")],
          },
          {
            type: "table_row",
            content: [
              cell("table_cell", "A1", { alignment: "left", colwidth: [110] }),
              cell("table_cell", "A2", { alignment: "right", colwidth: [220] }),
            ],
          },
          {
            type: "table_row",
            content: [cell("table_cell", "B1"), cell("table_cell", "B2")],
          },
        ],
      },
    ],
  };
}

function createTableEditor() {
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content: tableContent() });
  return editor;
}

function createThreeColumnEditor() {
  const content = tableContent();
  const rows = content.content?.[0].content;
  rows?.[0].content?.push(cell("table_header", "H3"));
  rows?.[1].content?.push(cell("table_cell", "A3"));
  rows?.[2].content?.push(cell("table_cell", "B3"));
  editor = new Editor({ extensions: createStandaloneEditorExtensions(), content });
  return editor;
}

function selectText(current: Editor, text: string) {
  let position = -1;
  current.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) position = pos;
  });
  expect(position).toBeGreaterThan(0);
  current.commands.setTextSelection(position);
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

function selectCells(current: Editor, anchor: string, head: string) {
  current.view.dispatch(
    current.state.tr.setSelection(
      CellSelection.create(
        current.state.doc,
        cellPosition(current, anchor),
        cellPosition(current, head),
      ),
    ),
  );
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

describe("table move transforms", () => {
  it("moves body rows up and down without crossing the header", () => {
    const current = createTableEditor();
    selectText(current, "B1");

    expect(moveTableRow(-1)(current.state, current.view.dispatch)).toBe(true);
    expect(rowText(current)).toEqual([
      ["H1", "H2"],
      ["B1", "B2"],
      ["A1", "A2"],
    ]);
    expect(tableSelection(current.state)?.row).toBe(1);

    expect(moveTableRow(1)(current.state, current.view.dispatch)).toBe(true);
    expect(rowText(current)[2]).toEqual(["B1", "B2"]);
  });

  it("keeps cell content, column width, and alignment together", () => {
    const current = createTableEditor();
    selectText(current, "A2");

    expect(moveTableColumn(-1)(current.state, current.view.dispatch)).toBe(true);
    expect(rowText(current)).toEqual([
      ["H2", "H1"],
      ["A2", "A1"],
      ["B2", "B1"],
    ]);
    const moved = current.state.doc.firstChild?.child(1).child(0);
    expect(moved?.attrs).toMatchObject({ alignment: "right", colwidth: [220] });
  });

  it("refuses header and boundary moves", () => {
    const current = createTableEditor();
    selectText(current, "H1");
    expect(moveTableRow(1)(current.state, current.view.dispatch)).toBe(false);

    selectText(current, "A1");
    expect(moveTableRow(-1)(current.state, current.view.dispatch)).toBe(false);
    expect(moveTableColumn(-1)(current.state, current.view.dispatch)).toBe(false);

    selectText(current, "B1");
    expect(moveTableRow(1)(current.state, current.view.dispatch)).toBe(false);
    expect(rowText(current)[0]).toEqual(["H1", "H2"]);
  });

  it("aligns the whole selected column and resets width plus table alignment", () => {
    const current = createTableEditor();
    selectText(current, "A2");
    expect(alignTableColumn("center")(current.state, current.view.dispatch)).toBe(true);
    const table = current.state.doc.firstChild;
    expect(table?.child(0).child(1).attrs.alignment).toBe("center");
    expect(table?.child(1).child(1).attrs.alignment).toBe("center");
    expect(table?.child(2).child(1).attrs.alignment).toBe("center");

    if (!table) throw new Error("table is missing");
    current.view.dispatch(
      current.state.tr.setNodeMarkup(0, undefined, { ...table.attrs, align: "right" }),
    );
    expect(resetTableLayout(current.state, current.view.dispatch)).toBe(true);
    expect(current.state.doc.firstChild?.attrs.align).toBeNull();
    expect(current.state.doc.firstChild?.child(1).child(0).attrs.colwidth).toBeNull();
  });

  it("models CellSelection rectangles and rejects header-crossing row transforms", () => {
    const current = createTableEditor();
    // Reverse direction reproduces the drag shape whose $from endpoint is in the body.
    selectCells(current, "A2", "H1");

    expect(tableSelection(current.state)).toMatchObject({
      rowFrom: 0,
      rowTo: 1,
      columnFrom: 0,
      columnTo: 1,
    });
    expect(moveTableRow(-1)(current.state, current.view.dispatch)).toBe(false);
    expect(moveTableRow(1)(current.state, current.view.dispatch)).toBe(false);
    expect(addTableRow("above")(current.state, current.view.dispatch)).toBe(false);
    expect(rowText(current)[0]).toEqual(["H1", "H2"]);
  });

  it("applies column operations to every column in a CellSelection", () => {
    const current = createTableEditor();
    selectCells(current, "H1", "A2");

    expect(alignTableColumn("center")(current.state, current.view.dispatch)).toBe(true);
    const table = current.state.doc.firstChild;
    for (let row = 0; row < 3; row += 1) {
      expect(table?.child(row).child(0).attrs.alignment).toBe("center");
      expect(table?.child(row).child(1).attrs.alignment).toBe("center");
    }
    expect(moveTableColumn(-1)(current.state, current.view.dispatch)).toBe(false);
    expect(moveTableColumn(1)(current.state, current.view.dispatch)).toBe(false);
  });

  it("moves a multi-column CellSelection as one range", () => {
    const current = createThreeColumnEditor();
    selectCells(current, "H1", "A2");

    expect(moveTableColumn(1)(current.state, current.view.dispatch)).toBe(true);
    expect(rowText(current)).toEqual([
      ["H3", "H1", "H2"],
      ["A3", "A1", "A2"],
      ["B3", "B1", "B2"],
    ]);
  });

  it("copies header alignment into a newly inserted row", () => {
    const current = createTableEditor();
    selectText(current, "A2");
    expect(alignTableColumn("center")(current.state, current.view.dispatch)).toBe(true);
    expect(addTableRow("below")(current.state, current.view.dispatch)).toBe(true);

    const inserted = current.state.doc.firstChild?.child(2);
    expect(inserted?.child(0).attrs.alignment).toBeNull();
    expect(inserted?.child(1).attrs.alignment).toBe("center");
  });

  it("adds a body row below a header selection", () => {
    const current = createTableEditor();
    selectText(current, "H1");

    expect(addTableRow("below")(current.state, current.view.dispatch)).toBe(true);
    const table = current.state.doc.firstChild;
    expect(table?.childCount).toBe(4);
    expect(table?.child(0).firstChild?.type.name).toBe("table_header");
    expect(table?.child(1).firstChild?.type.name).toBe("table_cell");
  });
});

describe("table creation and navigation", () => {
  it("inserts the standard header plus two body rows and selects the first header", () => {
    editor = new Editor({ extensions: createStandaloneEditorExtensions(), content: "<p></p>" });
    expect(editor.commands.insertTable()).toBe(true);

    const selection = tableSelection(editor.state);
    expect(selection).toMatchObject({ row: 0, column: 0 });
    expect(selection?.table.childCount).toBe(3);
    expect(selection?.table.firstChild?.childCount).toBe(3);
    expect(selection?.table.firstChild?.firstChild?.type.name).toBe("table_header");
  });

  it("uses Tab to append a row from the final cell and Shift-Tab to navigate back", () => {
    editor = new Editor({ extensions: createStandaloneEditorExtensions(), content: "<p></p>" });
    editor.commands.insertTable();
    const table = editor.state.doc.firstChild;
    if (!table) throw new Error("table was not inserted");

    // Empty cells have no text node; the paragraph's valid cursor is two tokens into the cell.
    let lastCellPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.spec.tableRole === "cell") lastCellPos = pos;
    });
    editor.commands.setTextSelection(lastCellPos + 2);
    editor.view.dom.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));

    expect(editor.state.doc.firstChild?.childCount).toBe(4);
    expect(tableSelection(editor.state)?.row).toBe(3);
    editor.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true }),
    );
    expect(tableSelection(editor.state)?.row).toBe(2);
  });
});

describe("resizable table rendering", () => {
  it("updates block alignment on the resize plugin's node view", () => {
    const current = createTableEditor();
    const table = current.state.doc.firstChild;
    if (!table) throw new Error("table is missing");
    const centered = table.type.create({ ...table.attrs, align: "center" }, table.content);
    const view = new MeridianTableView(centered, 100);

    expect(view.table.dataset.align).toBe("center");
    expect(view.table.style.marginRight).toBe("auto");

    const right = table.type.create({ ...table.attrs, align: "right" }, table.content);
    expect(view.update(right)).toBe(true);
    expect(view.table.dataset.align).toBe("right");
    expect(view.table.style.marginRight).toBe("0px");

    expect(view.update(table)).toBe(true);
    expect(view.table.dataset.align).toBeUndefined();
    expect(view.table.style.marginLeft).toBe("");
  });

  it("clears rendered column widths when the layout is reset", () => {
    const current = createTableEditor();
    const table = current.state.doc.firstChild;
    if (!table) throw new Error("table is missing");
    const firstRow = table.firstChild;
    if (!firstRow) throw new Error("table row is missing");
    const resizedRow = firstRow.type.create(
      firstRow.attrs,
      firstRow.content.replaceChild(
        0,
        firstRow
          .child(0)
          .type.create({ ...firstRow.child(0).attrs, colwidth: [302] }, firstRow.child(0).content),
      ),
    );
    const resized = table.type.create(table.attrs, table.content.replaceChild(0, resizedRow));
    const view = new MeridianTableView(resized, 100);
    const firstColumn = view.colgroup.firstElementChild as HTMLElement | null;

    expect(firstColumn?.style.width).toBe("302px");
    selectText(current, "H1");
    expect(resetTableLayout(current.state, current.view.dispatch)).toBe(true);
    const reset = current.state.doc.firstChild;
    if (!reset) throw new Error("reset table is missing");
    expect(view.update(reset)).toBe(true);
    expect(firstColumn?.style.width).toBe("");
  });
});
