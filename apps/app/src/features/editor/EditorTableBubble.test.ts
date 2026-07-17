// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
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
      addRow: false,
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
      addRow: true,
      moveRowUp: false,
      moveRowDown: true,
      deleteRow: true,
    });
  });
});
