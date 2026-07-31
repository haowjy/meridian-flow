// @vitest-environment jsdom
/**
 * Enter in a cell, at the key level rather than the command level.
 *
 * Every claim here is about the ladder Enter walks, so every case presses the
 * key against a mounted editor: the bug was that nothing owned Enter at table
 * scope, which no test of `setHardBreak` could have seen.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import { CellSelection } from "@tiptap/pm/tables";
import { afterEach, describe, expect, it } from "vitest";

import { installJsdomLayout } from "@/test-support/jsdom-layout";

import { getEditorChrome } from "../chrome";

import { createStandaloneEditorExtensions } from "../config";
import type { SlashCommandCatalog } from "./slash";
import { getSlashMenu } from "./slash";

let editor: Editor | null = null;

// The table extensions ask the view where a textblock ends.
installJsdomLayout();

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: text ? [{ type: "text", text }] : [],
});

const cell = (...content: JSONContent[]): JSONContent => ({ type: "table_cell", content });

const table: JSONContent = {
  type: "table",
  content: [
    { type: "table_row", content: [cell(paragraph("Terrace")), cell(paragraph("Question"))] },
    { type: "table_row", content: [cell(paragraph("First")), cell(paragraph("Who are you?"))] },
  ],
};

const CATALOG: SlashCommandCatalog = {
  menuLabel: "Insert block",
  groupLabels: { text: "Text", insert: "Insert" },
  requestImageUpload: () => {},
  items: [{ id: "image", group: "insert", label: "Picture", aliases: [] }],
};

function mount(content: JSONContent[], slash = false): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: createStandaloneEditorExtensions(
      slash ? { slashCommands: { catalog: () => CATALOG } } : {},
    ),
    content: { type: "doc", content },
  });
  return editor;
}

/** Press Enter; true when something refused the browser's default. */
function pressEnter(instance: Editor, shiftKey = false): boolean {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  instance.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

/** The position just inside the nth node of a type. */
function insideNode(instance: Editor, type: string, index = 0): number {
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

function caretAt(instance: Editor, pos: number) {
  instance.view.dispatch(
    instance.state.tr.setSelection(TextSelection.create(instance.state.doc, pos)),
  );
}

/** The nth cell's paragraph, as `[text, "break", text]`. */
function cellShape(instance: Editor, index = 0): string[] {
  const { node } = nodeAt(instance, "table_cell", index);
  const shape: string[] = [];
  node.firstChild?.forEach((child) => {
    shape.push(child.type.name === "hard_break" ? "break" : (child.text ?? child.type.name));
  });
  return shape;
}

function cellBlockShape(instance: Editor, index = 0): Array<{ type: string; text: string }> {
  const { node } = nodeAt(instance, "table_cell", index);
  return [...node.content.content].map((child) => ({
    type: child.type.name,
    text: child.textContent,
  }));
}

function nodeAt(instance: Editor, type: string, index: number): { node: PMNode; pos: number } {
  let seen = 0;
  let found: { node: PMNode; pos: number } | null = null;
  instance.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === type && seen++ === index) found = { node, pos };
    return found === null;
  });
  if (!found) throw new Error(`no ${type}[${index}] in the fixture`);
  return found;
}

/** Types, then drains the microtask queue `@tiptap/suggestion` resolves items on. */
async function type(instance: Editor, text: string) {
  instance.commands.insertContent(text);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Enter in a table cell", () => {
  it("splits the paragraph where the caret stands", () => {
    const instance = mount([paragraph("above"), table]);
    // After "Terrace".
    caretAt(instance, insideNode(instance, "table_cell") + 1 + "Terrace".length);

    expect(pressEnter(instance)).toBe(true);
    expect(cellBlockShape(instance)).toEqual([
      { type: "paragraph", text: "Terrace" },
      { type: "paragraph", text: "" },
    ]);
    expect(instance.state.selection.$head.parent.type.name).toBe("paragraph");
  });

  it("starts a second paragraph at the beginning of the cell", () => {
    const instance = mount([table]);
    caretAt(instance, insideNode(instance, "table_cell") + 1);

    pressEnter(instance);
    expect(cellBlockShape(instance)).toEqual([
      { type: "paragraph", text: "" },
      { type: "paragraph", text: "Terrace" },
    ]);
    expect(instance.state.doc.child(0).childCount).toBe(2);
  });

  it("deletes a selected range and splits the paragraph", () => {
    const instance = mount([table]);
    const start = insideNode(instance, "table_cell") + 1;
    instance.view.dispatch(
      instance.state.tr.setSelection(
        TextSelection.create(instance.state.doc, start + 3, start + "Terrace".length),
      ),
    );

    expect(pressEnter(instance)).toBe(true);
    expect(cellBlockShape(instance)).toEqual([
      { type: "paragraph", text: "Ter" },
      { type: "paragraph", text: "" },
    ]);
  });

  it("keeps Shift-Enter as a hard break while Enter splits", () => {
    const withEnter = mount([table]);
    caretAt(withEnter, insideNode(withEnter, "table_cell") + 4);
    pressEnter(withEnter);
    const enterShape = cellBlockShape(withEnter);
    withEnter.destroy();

    const withShift = mount([table]);
    caretAt(withShift, insideNode(withShift, "table_cell") + 4);
    pressEnter(withShift, true);

    expect(enterShape).toEqual([
      { type: "paragraph", text: "Ter" },
      { type: "paragraph", text: "race" },
    ]);
    expect(cellShape(withShift)).toEqual(["Ter", "break", "race"]);
  });

  it("keeps the key, and the cells, when a rectangle of them is swept", () => {
    const instance = mount([table]);
    const anchor = instance.state.doc.resolve(insideNode(instance, "table_cell") - 1);
    const head = instance.state.doc.resolve(insideNode(instance, "table_cell", 1) - 1);
    instance.view.dispatch(instance.state.tr.setSelection(new CellSelection(anchor, head)));
    const before = JSON.stringify(instance.state.doc.toJSON());

    expect(pressEnter(instance)).toBe(true);
    expect(JSON.stringify(instance.state.doc.toJSON())).toBe(before);
  });
});

describe("Enter everywhere else", () => {
  it("still splits a paragraph outside a table", () => {
    const instance = mount([paragraph("The third gate opened.")]);
    caretAt(instance, 4);

    expect(pressEnter(instance)).toBe(true);
    expect(instance.state.doc.childCount).toBe(2);
    expect(instance.state.doc.child(0).textContent).toBe("The");
    expect(instance.state.doc.child(1).textContent).toBe(" third gate opened.");
  });

  it("still splits a paragraph under a table", () => {
    const instance = mount([table, paragraph("The third gate opened.")]);
    caretAt(instance, instance.state.doc.content.size - " third gate opened.".length - 1);

    expect(pressEnter(instance)).toBe(true);
    expect(instance.state.doc.childCount).toBe(3);
    expect(instance.state.doc.child(2).textContent).toBe(" third gate opened.");
  });

  it("goes to an open slash menu rather than the cell it is open in", async () => {
    const instance = mount([table], true);
    caretAt(instance, insideNode(instance, "table_cell") + 1 + "Terrace".length);
    await type(instance, " /");
    // What the menu's popover opens in the app (`EditorPopover`): layer scope
    // is live only while a surface is, and the precedence claim is about a menu
    // the writer can see.
    const popover = getEditorChrome(instance)?.openLayer({
      id: "slash-menu",
      close: () => getSlashMenu(instance)?.dismiss(),
    });

    expect(getSlashMenu(instance)?.snapshot().open).toBe(true);
    expect(pressEnter(instance)).toBe(true);
    // The Picture entry took the trigger text with it; no line was broken.
    expect(getSlashMenu(instance)?.snapshot().open).toBe(false);
    expect(cellShape(instance)).toEqual(["Terrace "]);
    popover?.release();
  });
});
