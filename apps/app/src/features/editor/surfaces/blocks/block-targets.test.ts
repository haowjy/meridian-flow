// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";

import {
  blockAt,
  blockAtIndex,
  blockForSelection,
  blockSeams,
  deleteBlockTransaction,
  duplicateBlockTransaction,
  moveBlockStepTransaction,
  moveBlockToSeamTransaction,
  selectionIsInsideTable,
} from "./block-targets";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const heading = (text: string): JSONContent => ({
  type: "heading",
  attrs: { level: 2 },
  content: [{ type: "text", text }],
});

const codeBlock = (text: string): JSONContent => ({
  type: "code_block",
  attrs: { language: "ts" },
  content: [{ type: "text", text }],
});

const mermaid: JSONContent = {
  type: "code_block",
  attrs: { language: "mermaid" },
  content: [{ type: "text", text: "graph TD; a-->b;" }],
};

const figure: JSONContent = { type: "figure", attrs: { src: "asset:1", caption: "" } };

const rule: JSONContent = { type: "horizontal_rule" };

const bulletList: JSONContent = {
  type: "bullet_list",
  content: [
    { type: "list_item", content: [paragraph("first")] },
    { type: "list_item", content: [paragraph("second")] },
  ],
};

const table: JSONContent = {
  type: "table",
  content: [
    {
      type: "table_row",
      content: [
        { type: "table_header", content: [paragraph("head")] },
        { type: "table_header", content: [paragraph("count")] },
      ],
    },
    {
      type: "table_row",
      content: [
        { type: "table_cell", content: [paragraph("cell")] },
        { type: "table_cell", content: [paragraph("1")] },
      ],
    },
  ],
};

function mount(content: JSONContent[]): Editor {
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content },
  });
  return editor;
}

/** The document's top-level shape, which is what every move is judged by. */
function outline(instance: Editor): string[] {
  const names: string[] = [];
  instance.state.doc.forEach((node) => {
    names.push(
      node.type.name === "code_block" ? `code_block:${node.attrs.language}` : node.type.name,
    );
  });
  return names;
}

function textOutline(instance: Editor): string[] {
  const texts: string[] = [];
  instance.state.doc.forEach((node) => {
    texts.push(node.textContent);
  });
  return texts;
}

function blockOf(instance: Editor, index: number) {
  const block = blockAtIndex(instance.state.doc, index);
  if (!block) throw new Error(`no block at index ${index}`);
  return block;
}

function caretIn(instance: Editor, index: number) {
  const block = blockOf(instance, index);
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.near(instance.state.doc.resolve(block.pos + 1))),
  );
}

describe("top-level block resolution", () => {
  it("answers with the top-level block however deep the position sits", () => {
    const instance = mount([paragraph("one"), bulletList, table]);
    const { doc } = instance.state;

    const list = blockOf(instance, 1);
    const grid = blockOf(instance, 2);

    // A position inside a list item and a position inside a table cell both
    // answer with the top-level block, not the leaf paragraph they sit in.
    expect(blockAt(doc, list.pos + 4)?.index).toBe(1);
    expect(blockAt(doc, grid.pos + 6)?.index).toBe(2);
  });

  it("resolves a caret to its block and a selected object to its own", () => {
    const instance = mount([paragraph("one"), figure, paragraph("two")]);
    caretIn(instance, 2);
    expect(blockForSelection(instance.state)?.index).toBe(2);

    const object = blockOf(instance, 1);
    instance.view.dispatch(
      instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, object.pos)),
    );
    expect(blockForSelection(instance.state)?.index).toBe(1);
  });

  it("declines a caret inside table cells and keeps the table itself", () => {
    const instance = mount([paragraph("one"), table]);
    const grid = blockOf(instance, 1);

    instance.view.dispatch(
      instance.state.tr.setSelection(TextSelection.near(instance.state.doc.resolve(grid.pos + 6))),
    );
    expect(selectionIsInsideTable(instance.state)).toBe(true);

    caretIn(instance, 0);
    expect(selectionIsInsideTable(instance.state)).toBe(false);
  });
});

describe("drop seams", () => {
  it("puts one seam before every block and one after the last", () => {
    const instance = mount([paragraph("one"), table, codeBlock("x"), figure, rule]);
    const seams = blockSeams(instance.state.doc);

    expect(seams).toHaveLength(instance.state.doc.childCount + 1);
    expect(seams[0]).toBe(0);
    expect(seams.at(-1)).toBe(instance.state.doc.content.size);
  });

  it("lands every seam at document depth, never inside a block", () => {
    const instance = mount([paragraph("one"), table, bulletList, mermaid, figure]);
    const { doc } = instance.state;

    for (const seam of blockSeams(doc)) {
      expect(doc.resolve(seam).depth).toBe(0);
    }
  });

  // The truth table §5.8 asks for: a paragraph moved before and after every
  // block type in turn, with the document's shape read back each time.
  const blockTypes: Array<[string, JSONContent]> = [
    ["table", table],
    ["code block", codeBlock("const x = 1")],
    ["diagram", mermaid],
    ["figure", figure],
    ["list", bulletList],
    ["heading", heading("Chapter")],
    ["rule", rule],
  ];

  for (const [name, block] of blockTypes) {
    it(`moves a paragraph before and after a ${name}`, () => {
      const instance = mount([paragraph("mover"), block, paragraph("tail")]);
      const shape = outline(instance);

      // After the neighbour: seam 2 is the gap between it and the tail.
      const forward = moveBlockToSeamTransaction(instance.state, blockOf(instance, 0), 2);
      expect(forward).not.toBeNull();
      if (forward) instance.view.dispatch(forward);
      expect(outline(instance)).toEqual([shape[1], shape[0], shape[2]]);
      expect(textOutline(instance)[1]).toBe("mover");

      // And back before it.
      const back = moveBlockToSeamTransaction(instance.state, blockOf(instance, 1), 0);
      expect(back).not.toBeNull();
      if (back) instance.view.dispatch(back);
      expect(outline(instance)).toEqual(shape);
    });
  }

  it("refuses the two seams a block already sits between", () => {
    const instance = mount([paragraph("one"), paragraph("two"), paragraph("three")]);
    const middle = blockOf(instance, 1);

    expect(moveBlockToSeamTransaction(instance.state, middle, 1)).toBeNull();
    expect(moveBlockToSeamTransaction(instance.state, middle, 2)).toBeNull();
    expect(moveBlockToSeamTransaction(instance.state, middle, 0)).not.toBeNull();
    expect(moveBlockToSeamTransaction(instance.state, middle, 3)).not.toBeNull();
  });

  it("refuses a seam off the ends of the document", () => {
    const instance = mount([paragraph("one"), paragraph("two")]);
    const first = blockOf(instance, 0);

    expect(moveBlockToSeamTransaction(instance.state, first, -1)).toBeNull();
    expect(moveBlockToSeamTransaction(instance.state, first, 3)).toBeNull();
  });

  it("moves a table to the end of the document and keeps it whole", () => {
    const instance = mount([paragraph("one"), table, paragraph("two")]);
    const grid = blockOf(instance, 1);

    const tr = moveBlockToSeamTransaction(instance.state, grid, 3);
    expect(tr).not.toBeNull();
    if (tr) instance.view.dispatch(tr);

    expect(outline(instance)).toEqual(["paragraph", "paragraph", "table"]);
    const moved = blockAtIndex(instance.state.doc, 2);
    expect(moved?.node.childCount).toBe(2);
  });
});

describe("Alt+Arrow steps", () => {
  it("walks a block through the document one neighbour at a time", () => {
    const instance = mount([paragraph("a"), paragraph("b"), paragraph("c")]);
    caretIn(instance, 0);

    for (let step = 0; step < 2; step += 1) {
      const target = blockForSelection(instance.state);
      if (!target) throw new Error("no target");
      const tr = moveBlockStepTransaction(instance.state, target, "down");
      expect(tr).not.toBeNull();
      if (tr) instance.view.dispatch(tr);
    }

    expect(textOutline(instance)).toEqual(["b", "c", "a"]);
    // The caret travelled with the block: it is still in "a".
    expect(blockForSelection(instance.state)?.index).toBe(2);
  });

  it("no-ops at the first and last block without erroring", () => {
    const instance = mount([paragraph("a"), paragraph("b")]);
    const first = blockOf(instance, 0);
    const last = blockOf(instance, 1);

    expect(moveBlockStepTransaction(instance.state, first, "up")).toBeNull();
    expect(moveBlockStepTransaction(instance.state, last, "down")).toBeNull();
    expect(moveBlockStepTransaction(instance.state, first, "down")).not.toBeNull();
    expect(moveBlockStepTransaction(instance.state, last, "up")).not.toBeNull();
  });

  it("no-ops on a single-block document in both directions", () => {
    const instance = mount([paragraph("alone")]);
    const only = blockOf(instance, 0);

    expect(moveBlockStepTransaction(instance.state, only, "up")).toBeNull();
    expect(moveBlockStepTransaction(instance.state, only, "down")).toBeNull();
  });

  it("carries a selected object's selection to its new place", () => {
    const instance = mount([paragraph("one"), figure]);
    const object = blockOf(instance, 1);
    instance.view.dispatch(
      instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, object.pos)),
    );

    const target = blockForSelection(instance.state);
    if (!target) throw new Error("no target");
    const tr = moveBlockStepTransaction(instance.state, target, "up");
    if (tr) instance.view.dispatch(tr);

    expect(outline(instance)).toEqual(["figure", "paragraph"]);
    expect(instance.state.selection).toBeInstanceOf(NodeSelection);
    expect(blockForSelection(instance.state)?.index).toBe(0);
  });
});

describe("duplicate and delete", () => {
  it("duplicates a block right after itself and lands the caret in the copy", () => {
    const instance = mount([paragraph("one"), paragraph("two")]);
    caretIn(instance, 0);

    const target = blockForSelection(instance.state);
    if (!target) throw new Error("no target");
    const tr = duplicateBlockTransaction(instance.state, target);
    if (tr) instance.view.dispatch(tr);

    expect(textOutline(instance)).toEqual(["one", "one", "two"]);
    expect(blockForSelection(instance.state)?.index).toBe(1);
  });

  it("duplicates a table whole", () => {
    const instance = mount([table]);
    const grid = blockOf(instance, 0);
    const tr = duplicateBlockTransaction(instance.state, grid);
    if (tr) instance.view.dispatch(tr);

    expect(outline(instance)).toEqual(["table", "table"]);
  });

  it("deletes a block and leaves the caret beside the gap", () => {
    const instance = mount([paragraph("one"), paragraph("two"), paragraph("three")]);
    const middle = blockOf(instance, 1);

    const tr = deleteBlockTransaction(instance.state, middle);
    if (tr) instance.view.dispatch(tr);

    expect(textOutline(instance)).toEqual(["one", "three"]);
    expect(blockForSelection(instance.state)?.index).toBe(1);
  });

  it("leaves an empty paragraph behind when the last block is deleted", () => {
    const instance = mount([figure]);
    const only = blockOf(instance, 0);

    const tr = deleteBlockTransaction(instance.state, only);
    if (tr) instance.view.dispatch(tr);

    expect(outline(instance)).toEqual(["paragraph"]);
    expect(instance.state.doc.textContent).toBe("");
  });

  it("has nothing to do when the only block is already an empty paragraph", () => {
    const instance = mount([{ type: "paragraph" }]);
    const only = blockOf(instance, 0);

    expect(deleteBlockTransaction(instance.state, only)).toBeNull();
  });
});
