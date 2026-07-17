// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "./config";
import { MeridianTableView } from "./extensions/meridian-extensions";
import {
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

function selectText(current: Editor, text: string) {
  let position = -1;
  current.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) position = pos;
  });
  expect(position).toBeGreaterThan(0);
  current.commands.setTextSelection(position);
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
});
