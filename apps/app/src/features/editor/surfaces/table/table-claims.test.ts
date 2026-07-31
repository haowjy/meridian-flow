// @vitest-environment jsdom
/**
 * A swept rectangle of cells is the one table selection no grip can make, and
 * the only path to merging two arbitrary cells. Right-clicking it has to reach
 * a menu: nobody else on the ladder wants it, so silence is what happens if
 * this lane does not take it.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";

import {
  type ContextClaimTarget,
  chromeContextAt,
  editorChromeAttributes,
  getEditorChrome,
} from "@/core/editor/chrome";
import { createStandaloneEditorExtensions } from "@/core/editor/config";
import { claimsFormattingMenu } from "../formatting/formatting-triggers";
import { claimedSweptCells } from "./table-commands";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent =>
  text === "" ? { type: "paragraph" } : { type: "paragraph", content: [{ type: "text", text }] };

const cell = (type: "table_header" | "table_cell", text: string): JSONContent => ({
  type,
  attrs: {},
  content: [paragraph(text)],
});

function editorWithTable(): Editor {
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
            {
              type: "table_row",
              content: [cell("table_cell", "A1"), cell("table_cell", "A2")],
            },
            {
              type: "table_row",
              content: [cell("table_cell", "B1"), cell("table_cell", "B2")],
            },
          ],
        },
        paragraph("after"),
      ],
    },
  });
  return editor;
}

function cellPosition(current: Editor, text: string): number {
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

function sweep(current: Editor, anchor: string, head: string) {
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

function element(): HTMLElement {
  const node = document.createElement("td");
  document.body.appendChild(node);
  return node;
}

/** A portalled grip, marked the way the kernel asks a lane to mark it. */
function chromeElement(current: Editor): HTMLElement {
  const chrome = getEditorChrome(current);
  if (!chrome) throw new Error("the editor mounted no chrome");
  const row = document.createElement("div");
  for (const [attribute, value] of Object.entries(editorChromeAttributes(chrome))) {
    row.setAttribute(attribute, value);
  }
  const button = document.createElement("button");
  row.appendChild(button);
  document.body.appendChild(row);
  return button;
}

function rightClickAt(current: Editor, docPos: number | null): ContextClaimTarget {
  return {
    element: element(),
    docPos,
    context:
      docPos === null
        ? chromeContextAt(current.state.doc, 0)
        : chromeContextAt(current.state.doc, docPos),
    // A CellSelection is not a text selection, so the kernel never sets this.
    insideTextSelection: false,
    event: { clientX: 120, clientY: 240 } as MouseEvent,
  };
}

/** A position inside the cell holding `text`, which is where a writer aims. */
function insideCell(current: Editor, text: string): number {
  return cellPosition(current, text) + 2;
}

describe("who takes a right-click on swept cells", () => {
  it("is nobody else: the formatting menu declines a cell selection", () => {
    const current = editorWithTable();
    sweep(current, "A1", "A2");

    // `proseSelectionCovers` admits TextSelection and AllSelection only, so the
    // kernel reports no text selection and the formatting rung stands down.
    expect(claimsFormattingMenu(current, rightClickAt(current, insideCell(current, "A1")))).toBe(
      false,
    );
  });

  it("takes a right-click inside the swept rectangle, and says which cells it took", () => {
    const current = editorWithTable();
    sweep(current, "A1", "A2");

    // The cells rather than a yes: the claim is where the menu takes hold of
    // what it will act on, and the selection it read is gone by the next write.
    const swept = { anchor: cellPosition(current, "A1"), head: cellPosition(current, "A2") };
    expect(claimedSweptCells(current, rightClickAt(current, insideCell(current, "A1")))).toEqual(
      swept,
    );
    expect(claimedSweptCells(current, rightClickAt(current, insideCell(current, "A2")))).toEqual(
      swept,
    );
  });

  it("declines a cell the sweep did not cover", () => {
    const current = editorWithTable();
    sweep(current, "A1", "A2");

    // The row below is inside the selection's from/to range but outside the
    // rectangle: aiming at it is not aiming at what was selected.
    expect(claimedSweptCells(current, rightClickAt(current, insideCell(current, "B1")))).toBeNull();
  });

  it("declines a bare caret in a cell, which the ladder's floor takes instead", () => {
    const current = editorWithTable();
    current.commands.setTextSelection(insideCell(current, "A1"));

    expect(claimedSweptCells(current, rightClickAt(current, insideCell(current, "A1")))).toBeNull();
  });

  it("declines the lane's own portalled chrome and a pointer off the prose", () => {
    const current = editorWithTable();
    sweep(current, "A1", "A2");

    const onChrome = {
      ...rightClickAt(current, insideCell(current, "A1")),
      element: chromeElement(current),
    };
    expect(claimedSweptCells(current, onChrome)).toBeNull();
    expect(claimedSweptCells(current, rightClickAt(current, null))).toBeNull();
  });

  it("declines a read-only document, which has no verbs to trade the browser for", () => {
    const current = editorWithTable();
    sweep(current, "A1", "A2");
    current.setEditable(false);

    expect(claimedSweptCells(current, rightClickAt(current, insideCell(current, "A1")))).toBeNull();
  });
});
