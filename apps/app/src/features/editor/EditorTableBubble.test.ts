// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { tableSelection } from "@/core/editor/table-operations";
import { matchTable, tableOperationAvailability } from "./EditorTableBubble";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function createTableEditor(editable = true) {
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: "<p></p>",
    editable,
  });
  editor.commands.insertTable();
  return editor;
}

describe("table bubble", () => {
  it("matches a table selection and declines read-only editors", () => {
    const current = createTableEditor();
    expect(matchTable(current)).toMatchObject({ nodePos: 0, from: 0 });

    current.setEditable(false);
    expect(matchTable(current)).toBeNull();
  });

  it("fixes the header row and guards row and column boundaries", () => {
    const current = createTableEditor();
    const header = tableSelection(current.state);
    if (!header) throw new Error("selection is outside the table");
    expect(tableOperationAvailability(header)).toMatchObject({
      addRowAbove: false,
      addRowBelow: true,
      moveRowUp: false,
      moveRowDown: false,
      deleteRow: false,
      moveColumnLeft: false,
      moveColumnRight: true,
      deleteColumn: true,
    });

    current.commands.goToNextCell();
    current.commands.goToNextCell();
    current.commands.goToNextCell();
    const firstBodyCell = tableSelection(current.state);
    if (!firstBodyCell) throw new Error("selection is outside the table");
    expect(tableOperationAvailability(firstBodyCell)).toMatchObject({
      addRowAbove: true,
      addRowBelow: true,
      moveRowUp: false,
      moveRowDown: true,
      deleteRow: true,
    });
  });

  it("disables header-violating operations for a rectangle spanning header and body", () => {
    const current = createTableEditor();
    const cells: number[] = [];
    current.state.doc.descendants((node, pos) => {
      if (node.type.spec.tableRole === "header_cell" || node.type.spec.tableRole === "cell") {
        cells.push(pos);
      }
    });
    // Anchor in the body so this covers the endpoint direction that bypassed the old guard.
    current.view.dispatch(
      current.state.tr.setSelection(CellSelection.create(current.state.doc, cells[5], cells[0])),
    );
    const rectangle = tableSelection(current.state);
    if (!rectangle) throw new Error("selection is outside the table");

    expect(tableOperationAvailability(rectangle)).toMatchObject({
      addRowAbove: false,
      addRowBelow: true,
      moveRowUp: false,
      moveRowDown: false,
      deleteRow: false,
      moveColumnLeft: false,
      deleteColumn: false,
    });
  });
});
