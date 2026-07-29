// @vitest-environment jsdom
/**
 * Turn into has two doors — the block menu's submenu and the formatting menu's
 * — and law 5/6 only holds if they answer alike. This asserts they read one
 * table rather than two, including on the targets a second table used to get
 * wrong: an embedded component and a selected figure.
 */
import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";

import { blockAtIndex } from "./blocks";
import { formattingMenuModel } from "./formatting";
import { BLOCK_TYPE_IDS, blockTypeStates, turnIntoBlockType } from "./toolbar";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

function mount(content: JSONContent[]): Editor {
  editor?.destroy();
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content },
  });
  return editor;
}

/** What the block menu does before it renders: stand the writer on the block. */
function standOn(instance: Editor, index: number) {
  const block = blockAtIndex(instance.state.doc, index);
  if (!block) throw new Error(`no block at index ${index}`);
  const selection = block.node.isTextblock
    ? TextSelection.near(instance.state.doc.resolve(block.pos + 1))
    : NodeSelection.create(instance.state.doc, block.pos);
  instance.view.dispatch(instance.state.tr.setSelection(selection));
}

/** The block menu's door: `blockTypeStates` keyed by the ids it renders. */
function blockMenuDoor(instance: Editor) {
  const states = blockTypeStates(instance);
  return Object.fromEntries(
    BLOCK_TYPE_IDS.map((id) => [
      id,
      { active: states[id].active, blockedBy: states[id].blockedBy },
    ]),
  );
}

/** The formatting menu's door: the same ids, through its own model. */
function formattingMenuDoor(instance: Editor) {
  const model = formattingMenuModel(instance);
  return Object.fromEntries(
    BLOCK_TYPE_IDS.map((id) => [
      id,
      { active: model.turnInto[id].active, blockedBy: model.turnInto[id].blockedBy },
    ]),
  );
}

describe("both Turn into doors read one table", () => {
  it("agrees on a paragraph, where every conversion runs", () => {
    const instance = mount([paragraph("prose")]);
    standOn(instance, 0);

    const door = blockMenuDoor(instance);
    expect(door).toEqual(formattingMenuDoor(instance));
    expect(Object.values(door).every((state) => state.blockedBy === null)).toBe(true);
  });

  it("agrees on a heading, and checks exactly the type the block is", () => {
    const instance = mount([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Chapter" }] },
    ]);
    standOn(instance, 0);

    const door = blockMenuDoor(instance);
    expect(door).toEqual(formattingMenuDoor(instance));
    expect(BLOCK_TYPE_IDS.filter((id) => door[id].active)).toEqual(["heading2"]);
  });

  it("agrees inside a code fence, on the two conversions that reverse it", () => {
    const instance = mount([
      { type: "code_block", attrs: { language: "ts" }, content: [{ type: "text", text: "x" }] },
    ]);
    standOn(instance, 0);

    const door = blockMenuDoor(instance);
    expect(door).toEqual(formattingMenuDoor(instance));
    expect(door.paragraph.blockedBy).toBeNull();
    expect(door.codeBlock.blockedBy).toBeNull();
    expect(door.heading1.blockedBy).toBe("code-block");
    expect(door.blockquote.blockedBy).toBe("code-block");
  });

  it("agrees on an embedded component, which keeps its own block type", () => {
    const instance = mount([
      { type: "jsx_leaf", attrs: { name: "StatBlock" }, content: [{ type: "text", text: "{}" }] },
    ]);
    standOn(instance, 0);

    const door = blockMenuDoor(instance);
    expect(door).toEqual(formattingMenuDoor(instance));
    expect(Object.values(door).every((state) => state.blockedBy === "embedded-block")).toBe(true);
  });

  it("agrees on a selected figure, and refuses at dispatch too (F6)", () => {
    const instance = mount([{ type: "figure", attrs: { src: "asset:1", caption: "" } }]);
    standOn(instance, 0);

    const door = blockMenuDoor(instance);
    expect(door).toEqual(formattingMenuDoor(instance));
    expect(Object.values(door).every((state) => state.blockedBy === "object-selection")).toBe(true);

    // The greyed row is the first fence; dispatch is the second.
    expect(turnIntoBlockType(instance, "heading1")).toBe(false);
    expect(turnIntoBlockType(instance, "blockquote")).toBe(false);
    expect(instance.state.doc.firstChild?.type.name).toBe("figure");
  });
});
