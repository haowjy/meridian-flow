// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { installJsdomLayout } from "@/test-support/jsdom-layout";

import { createStandaloneEditorExtensions } from "../config";

let editor: Editor | null = null;

// Tab reaches prosemirror-tables, which asks the view where the textblock ends.
installJsdomLayout();

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const listItem = (text: string): JSONContent => ({
  type: "list_item",
  content: [paragraph(text)],
});

const cell = (text: string): JSONContent => ({
  type: "table_cell",
  content: [paragraph(text)],
});

const fence = (code: string): JSONContent => ({
  type: "code_block",
  attrs: { language: "python" },
  content: [{ type: "text", text: code }],
});

const table: JSONContent = {
  type: "table",
  content: [
    { type: "table_row", content: [cell("Terrace"), cell("Question")] },
    { type: "table_row", content: [cell("First"), cell("Who are you?")] },
  ],
};

function mount(content: JSONContent[], editable = true): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({
    element,
    editable,
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content },
  });
  return editor;
}

function caretInside(instance: Editor, type: string, index = 0): number {
  let seen = 0;
  let found: number | null = null;
  instance.state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node.type.name === type && seen++ === index) found = pos + 1;
    return found === null;
  });
  if (found === null) throw new Error(`no ${type}[${index}] in the fixture`);
  return found;
}

function selectText(instance: Editor, from: number, to: number) {
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.create(instance.state.doc, from, to)),
  );
}

function caretAt(instance: Editor, pos: number) {
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.near(instance.state.doc.resolve(pos))),
  );
}

/** Press the key; true when something refused the browser's default. */
function pressTab(instance: Editor, shiftKey = false): boolean {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  instance.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

/** The node type path down to the first list item, so nesting is visible. */
function listShape(instance: Editor): string[] {
  const shape: string[] = [];
  instance.state.doc.descendants((node) => {
    if (node.type.name === "bullet_list" || node.type.name === "list_item") {
      shape.push(node.type.name);
    }
    return true;
  });
  return shape;
}

describe("Tab never leaves the editor", () => {
  it("keeps the key in a heading", () => {
    const instance = mount([{ type: "heading", attrs: { level: 2 }, content: [] }]);
    caretAt(instance, 1);

    expect(pressTab(instance)).toBe(true);
  });

  it("keeps the key in a paragraph", () => {
    const instance = mount([paragraph("The third gate opened.")]);
    caretAt(instance, 4);

    expect(pressTab(instance)).toBe(true);
  });

  it("keeps the key on the first list item, which has nothing to indent under", () => {
    const instance = mount([
      { type: "bullet_list", content: [listItem("a copper needle"), listItem("a folded map")] },
    ]);
    caretAt(instance, caretInside(instance, "list_item") + 1);

    const before = listShape(instance);
    expect(pressTab(instance)).toBe(true);
    expect(listShape(instance)).toEqual(before);
    // Not a tab either: inside a list the key belongs to the list, refusal
    // included, and a tab in the first bullet's text is not what was asked for.
    expect(instance.state.doc.textContent).toBe("a copper needlea folded map");
  });

  it("keeps the key with an object selected", () => {
    const instance = mount([paragraph("before"), { type: "figure", attrs: { src: "asset:1" } }]);
    instance.commands.setNodeSelection(instance.state.doc.content.size - 1);

    expect(pressTab(instance)).toBe(true);
  });

  // A reader passing through a read-only document must still be able to tab
  // out of it. ProseMirror is what guarantees it — its edit handlers, keydown
  // among them, do not run on a view that is not editable — so this holds only
  // while Tab is owned through the editor's own keymap and not, say, a
  // document listener.
  it("hands the key back in a document nobody can type into", () => {
    const instance = mount([paragraph("The third gate opened.")], false);
    caretAt(instance, 4);

    expect(pressTab(instance)).toBe(false);
  });

  it("keeps Shift-Tab in a paragraph", () => {
    const instance = mount([paragraph("The third gate opened.")]);
    caretAt(instance, 4);

    expect(pressTab(instance, true)).toBe(true);
  });

  it("keeps Shift-Tab in the first table cell, where there is no previous cell", () => {
    const instance = mount([paragraph("above"), table]);
    caretAt(instance, caretInside(instance, "table_cell") + 1);

    expect(pressTab(instance, true)).toBe(true);
  });
});

describe("Tab makes a tab", () => {
  it("inserts one mid-sentence", () => {
    const instance = mount([paragraph("The third gate opened.")]);
    caretAt(instance, 4);

    expect(pressTab(instance)).toBe(true);
    expect(instance.state.doc.firstChild?.textContent).toBe("The\t third gate opened.");
    expect(instance.state.selection.$head.parent.type.name).toBe("paragraph");
  });

  it("inserts one at the front of a paragraph, where the wire needs an escape", () => {
    const instance = mount([paragraph("The third gate opened.")]);
    caretAt(instance, 1);

    expect(pressTab(instance)).toBe(true);
    expect(instance.state.doc.firstChild?.textContent).toBe("\tThe third gate opened.");
  });

  it("inserts one in a heading", () => {
    const instance = mount([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Chapter" }] },
    ]);
    caretAt(instance, 1);

    expect(pressTab(instance)).toBe(true);
    expect(instance.state.doc.firstChild?.textContent).toBe("\tChapter");
  });

  it("inserts one at the caret in a code fence", () => {
    const instance = mount([fence("qi = 1")]);
    caretAt(instance, caretInside(instance, "code_block") + 2);

    expect(pressTab(instance)).toBe(true);
    expect(instance.state.doc.firstChild?.textContent).toBe("qi\t = 1");
  });

  it("leaves a selected object alone: an indent key never replaces a picture", () => {
    const instance = mount([paragraph("before"), { type: "figure", attrs: { src: "asset:1" } }]);
    instance.commands.setNodeSelection(instance.state.doc.content.size - 1);

    expect(pressTab(instance)).toBe(true);
    expect(instance.state.doc.childCount).toBe(2);
    expect(instance.state.doc.textContent).toBe("before");
  });
});

describe("Tab across fence lines", () => {
  it("indents every line the selection touches", () => {
    const instance = mount([fence("one\ntwo\nthree")]);
    const start = caretInside(instance, "code_block");
    selectText(instance, start + 1, start + "one\ntw".length);

    expect(pressTab(instance)).toBe(true);
    expect(instance.state.doc.firstChild?.textContent).toBe("\tone\n\ttwo\nthree");
  });

  it("takes the indentation back on Shift-Tab", () => {
    const instance = mount([fence("\tone\n    two\nthree")]);
    const start = caretInside(instance, "code_block");
    selectText(instance, start + 1, start + "\tone\n    tw".length);

    expect(pressTab(instance, true)).toBe(true);
    expect(instance.state.doc.firstChild?.textContent).toBe("one\ntwo\nthree");
  });
});

describe("Tab where indenting is meaningful", () => {
  it("sinks a later list item under the one above it", () => {
    const instance = mount([
      { type: "bullet_list", content: [listItem("a copper needle"), listItem("a folded map")] },
    ]);
    caretAt(instance, caretInside(instance, "list_item", 1) + 1);

    expect(pressTab(instance)).toBe(true);
    expect(listShape(instance)).toEqual(["bullet_list", "list_item", "bullet_list", "list_item"]);
  });

  it("lifts a nested list item back out on Shift-Tab", () => {
    const instance = mount([
      { type: "bullet_list", content: [listItem("a copper needle"), listItem("a folded map")] },
    ]);
    caretAt(instance, caretInside(instance, "list_item", 1) + 1);
    pressTab(instance);
    caretAt(instance, caretInside(instance, "list_item", 1) + 1);

    expect(pressTab(instance, true)).toBe(true);
    expect(listShape(instance)).toEqual(["bullet_list", "list_item", "list_item"]);
  });

  it("walks to the next table cell", () => {
    const instance = mount([paragraph("above"), table]);
    caretAt(instance, caretInside(instance, "table_cell") + 1);

    expect(pressTab(instance)).toBe(true);
    expect(instance.state.selection.$from.node(-1).textContent).toBe("Question");
  });
});
