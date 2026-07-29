// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";

import { blockAtIndex } from "./block-targets";
import { applyTurnInto, type TurnIntoTargetId, turnIntoTargets } from "./turn-into";

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

function refusals(instance: Editor): Record<string, string | null> {
  return Object.fromEntries(
    turnIntoTargets(instance).map((target) => [target.id, target.blockedBy]),
  );
}

function activeTargets(instance: Editor): TurnIntoTargetId[] {
  return turnIntoTargets(instance)
    .filter((target) => target.active)
    .map((target) => target.id);
}

describe("turn into reads the block it is standing on", () => {
  it("offers every conversion on a paragraph, and marks it as the current type", () => {
    const instance = mount([paragraph("prose")]);
    standOn(instance, 0);

    expect(Object.values(refusals(instance)).every((reason) => reason === null)).toBe(true);
    expect(activeTargets(instance)).toEqual(["paragraph"]);
  });

  it("marks the heading level the block already is", () => {
    const instance = mount([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Chapter" }] },
    ]);
    standOn(instance, 0);

    expect(activeTargets(instance)).toEqual(["heading2"]);
  });

  // The toolbar's own exception, reached through the block menu: a fence
  // refuses every conversion except the two that undo it.
  it("keeps a code fence's block type except in the directions that reverse it", () => {
    const instance = mount([
      { type: "code_block", attrs: { language: "ts" }, content: [{ type: "text", text: "x" }] },
    ]);
    standOn(instance, 0);

    expect(refusals(instance)).toEqual({
      paragraph: null,
      heading1: "code-block",
      heading2: "code-block",
      heading3: "code-block",
      bulletList: "code-block",
      orderedList: "code-block",
      quote: "code-block",
      codeBlock: null,
    });
    expect(activeTargets(instance)).toEqual(["codeBlock"]);
  });

  it("refuses every conversion on an embedded component", () => {
    const instance = mount([
      { type: "jsx_leaf", attrs: { name: "StatBlock" }, content: [{ type: "text", text: "{}" }] },
    ]);
    standOn(instance, 0);

    expect(Object.values(refusals(instance)).every((reason) => reason === "embedded-block")).toBe(
      true,
    );
  });

  it("refuses every conversion on a selected object", () => {
    const instance = mount([{ type: "figure", attrs: { src: "asset:1", caption: "" } }]);
    standOn(instance, 0);

    expect(Object.values(refusals(instance)).every((reason) => reason === "object-selection")).toBe(
      true,
    );
  });
});

describe("turn into converts what it advertises", () => {
  it("converts a paragraph and reverses on the second choice (law 6)", () => {
    const instance = mount([paragraph("prose")]);
    standOn(instance, 0);

    expect(applyTurnInto(instance, "heading3")).toBe(true);
    expect(instance.state.doc.firstChild?.type.name).toBe("heading");
    expect(instance.state.doc.firstChild?.attrs.level).toBe(3);

    expect(applyTurnInto(instance, "heading3")).toBe(true);
    expect(instance.state.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("un-fences a code block through Paragraph", () => {
    const instance = mount([
      { type: "code_block", attrs: { language: "ts" }, content: [{ type: "text", text: "x" }] },
    ]);
    standOn(instance, 0);

    expect(applyTurnInto(instance, "paragraph")).toBe(true);
    expect(instance.state.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("refuses at dispatch what the menu greyed, however it is reached", () => {
    const instance = mount([{ type: "figure", attrs: { src: "asset:1", caption: "" } }]);
    standOn(instance, 0);

    // The F6 accident: a figure must not become a heading from any door.
    expect(applyTurnInto(instance, "heading1")).toBe(false);
    expect(applyTurnInto(instance, "quote")).toBe(false);
    expect(applyTurnInto(instance, "bulletList")).toBe(false);
    expect(instance.state.doc.firstChild?.type.name).toBe("figure");
  });

  it("wraps a paragraph in a list and a quote", () => {
    const instance = mount([paragraph("prose")]);

    standOn(instance, 0);
    expect(applyTurnInto(instance, "bulletList")).toBe(true);
    expect(instance.state.doc.firstChild?.type.name).toBe("bullet_list");

    const quoted = mount([paragraph("prose")]);
    standOn(quoted, 0);
    expect(applyTurnInto(quoted, "quote")).toBe(true);
    expect(quoted.state.doc.firstChild?.type.name).toBe("blockquote");
  });
});
