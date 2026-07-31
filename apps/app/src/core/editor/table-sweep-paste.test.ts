// @vitest-environment jsdom
/**
 * Paste over a swept rectangle of cells is a replace of the sweep.
 *
 * Every case runs the real paste pipeline (`pasteText` / `pasteHTML`), because
 * the subject is the seam between three answers: the markdown clipboard
 * parser, this module's sweep replace, and prosemirror-tables' rectangle
 * overwrite for table content. Which one answers is the behavior under test.
 */
import type { Editor, JSONContent } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditor, type StandaloneEditor } from "@/test-support/standalone-editor";

// jsdom ships no `ClipboardEvent`, and ProseMirror's own paste helpers build
// one when they are not handed an event. The browser has it; the harness does
// not.
if (typeof globalThis.ClipboardEvent === "undefined") {
  class StubClipboardEvent extends Event {}
  Object.defineProperty(globalThis, "ClipboardEvent", { value: StubClipboardEvent });
}

let mounted: StandaloneEditor | null = null;

afterEach(() => {
  mounted?.destroy();
  mounted = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const cell = (text: string): JSONContent => ({
  type: "table_cell",
  content: [paragraph(text)],
});

const row = (...cells: JSONContent[]): JSONContent => ({ type: "table_row", content: cells });

/** Two rows by three columns, so a sweep can leave cells outside it. */
const table2x3: JSONContent = {
  type: "table",
  content: [row(cell("a1"), cell("a2"), cell("a3")), row(cell("b1"), cell("b2"), cell("b3"))],
};

function mount(content: JSONContent[]): Editor {
  mounted = createStandaloneEditor({ content: { type: "doc", content } });
  return mounted.editor;
}

/** Positions of every cell, in document (row-major) order. */
function cellPositions(editor: Editor): number[] {
  const found: number[] = [];
  editor.state.doc.descendants((node, pos) => {
    const role = node.type.spec.tableRole;
    if (role === "cell" || role === "header_cell") found.push(pos);
    return true;
  });
  return found;
}

/** Sweep a `CellSelection` from one cell to another, by row-major index. */
function sweep(editor: Editor, anchorIndex: number, headIndex: number): void {
  const cells = cellPositions(editor);
  const selection = CellSelection.create(editor.state.doc, cells[anchorIndex], cells[headIndex]);
  editor.view.dispatch(editor.state.tr.setSelection(selection));
}

/** Caret at the end of a cell's last text, by row-major index. */
function caretInCell(editor: Editor, index: number): void {
  const pos = cellPositions(editor)[index];
  const node = editor.state.doc.nodeAt(pos);
  if (!node) throw new Error(`no cell at index ${index}`);
  const end = editor.state.doc.resolve(pos + node.nodeSize - 2);
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(end, -1)));
}

/** What each cell holds: its child block types and its flattened text. */
function cellSnapshots(editor: Editor): { blocks: string[]; text: string }[] {
  const cells: { blocks: string[]; text: string }[] = [];
  editor.state.doc.descendants((node) => {
    const role = node.type.spec.tableRole;
    if (role === "cell" || role === "header_cell") {
      const blocks: string[] = [];
      node.forEach((child) => {
        blocks.push(child.type.name);
      });
      cells.push({ blocks, text: node.textContent });
    }
    return true;
  });
  return cells;
}

describe("a caret in a cell takes the clipboard like prose", () => {
  it("inserts a multi-block clipboard inside the cell", () => {
    const editor = mount([table2x3]);
    caretInCell(editor, 4);

    editor.view.pasteText("## Heading\n\nAnd prose.");

    expect(cellSnapshots(editor)[4]).toEqual({
      blocks: ["paragraph", "heading", "paragraph"],
      text: "b2HeadingAnd prose.",
    });
    // The neighbours never hear about it.
    expect(cellSnapshots(editor)[3]).toEqual({ blocks: ["paragraph"], text: "b1" });
    expect(cellSnapshots(editor)[5]).toEqual({ blocks: ["paragraph"], text: "b3" });
  });

  it("still joins a single styled paragraph into the cell's sentence", () => {
    const editor = mount([table2x3]);
    caretInCell(editor, 4);

    editor.view.pasteText("a **bold** word");

    expect(cellSnapshots(editor)[4]).toEqual({ blocks: ["paragraph"], text: "b2a bold word" });
  });
});

describe("a sweep is a selection: paste replaces it", () => {
  it("lands the clipboard whole in the top-left cell and empties the rest", () => {
    const editor = mount([table2x3]);
    sweep(editor, 0, 4);

    editor.view.pasteText("## Heading\n\nAnd prose.");

    expect(cellSnapshots(editor)).toEqual([
      { blocks: ["heading", "paragraph"], text: "HeadingAnd prose." },
      { blocks: ["paragraph"], text: "" },
      { blocks: ["paragraph"], text: "a3" },
      { blocks: ["paragraph"], text: "" },
      { blocks: ["paragraph"], text: "" },
      { blocks: ["paragraph"], text: "b3" },
    ]);
  });

  it("lands top-left even when the sweep was dragged from the bottom-right", () => {
    const editor = mount([table2x3]);
    sweep(editor, 4, 0);

    editor.view.pasteText("## Heading\n\nAnd prose.");

    const cells = cellSnapshots(editor);
    expect(cells[0]).toEqual({ blocks: ["heading", "paragraph"], text: "HeadingAnd prose." });
    expect(cells[4]).toEqual({ blocks: ["paragraph"], text: "" });
  });

  it("is one undo step: swept cells and the landing come back together", () => {
    const editor = mount([table2x3]);
    editor.registerPlugin(history());
    const before = editor.state.doc.toJSON();
    sweep(editor, 0, 4);

    editor.view.pasteText("## Heading\n\nAnd prose.");
    expect(cellSnapshots(editor)[0].blocks).toEqual(["heading", "paragraph"]);

    undo(editor.view.state, editor.view.dispatch);
    expect(editor.state.doc.toJSON()).toEqual(before);
  });

  // The one exception, already prosemirror-tables' own: table content over a
  // sweep keeps the rectangle overwrite, because cells map onto cells.
  it("lets table content keep the rectangle overwrite", () => {
    const editor = mount([table2x3]);
    sweep(editor, 0, 4);

    editor.view.pasteHTML("<table><tbody><tr><td><p>X</p></td></tr></tbody></table>");

    expect(cellSnapshots(editor).map((snapshot) => snapshot.text)).toEqual([
      "X",
      "X",
      "a3",
      "X",
      "X",
      "b3",
    ]);
  });
});
