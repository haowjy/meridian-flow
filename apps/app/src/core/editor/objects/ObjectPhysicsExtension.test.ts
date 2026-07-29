// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { registerObjectEngagement, registerObjectKeymap } from "./ObjectPhysicsExtension";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const mermaid: JSONContent = {
  type: "code_block",
  attrs: { language: "mermaid" },
  content: [{ type: "text", text: "graph TD;" }],
};

function mount(content: JSONContent[]): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content },
  });
  return editor;
}

function positionOf(instance: Editor, type: string): number {
  let found: number | null = null;
  instance.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === type) found = pos;
    return found === null;
  });
  if (found === null) throw new Error(`no ${type} in the fixture`);
  return found;
}

function select(instance: Editor, pos: number) {
  instance.view.dispatch(
    instance.state.tr.setSelection(NodeSelection.create(instance.state.doc, pos)),
  );
}

function press(instance: Editor, init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  instance.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

function blockTypes(instance: Editor): string[] {
  const types: string[] = [];
  instance.state.doc.forEach((node) => {
    types.push(node.type.name);
  });
  return types;
}

describe("Enter on a selected object", () => {
  it("opens the surface its lane registered", () => {
    const instance = mount([paragraph("before"), mermaid, paragraph("after")]);
    const open = vi.fn(() => true);
    registerObjectEngagement(instance, "code_block", open);

    select(instance, positionOf(instance, "code_block"));
    expect(press(instance, { key: "Enter" })).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });

  it("never falls through to the base keymap, which would split the block", () => {
    const instance = mount([paragraph("before"), mermaid, paragraph("after")]);
    const before = blockTypes(instance);

    select(instance, positionOf(instance, "code_block"));
    expect(press(instance, { key: "Enter" })).toBe(true);

    // No lane has registered the diagram surface yet: the object is inert,
    // not a place where Enter quietly rewrites the manuscript.
    expect(blockTypes(instance)).toEqual(before);
  });

  it("engages a table by putting the caret in its first cell", () => {
    const instance = mount([
      {
        type: "table",
        content: [
          {
            type: "table_row",
            content: [
              { type: "table_header", content: [paragraph("Rank")] },
              { type: "table_header", content: [paragraph("Skill")] },
            ],
          },
        ],
      },
    ]);

    select(instance, positionOf(instance, "table"));
    expect(press(instance, { key: "Enter" })).toBe(true);
    expect(instance.state.selection.$head.parent.textContent).toBe("Rank");
  });
});

describe("arrow walking", () => {
  it("selects the object, then passes beyond it", () => {
    const instance = mount([paragraph("before"), mermaid, paragraph("after")]);
    // The caret at the end of the paragraph before the fence: the edge is
    // where "beside" starts.
    instance.commands.setTextSelection(positionOf(instance, "code_block") - 1);

    expect(press(instance, { key: "ArrowDown" })).toBe(true);
    expect(instance.state.selection).toBeInstanceOf(NodeSelection);

    expect(press(instance, { key: "ArrowDown" })).toBe(true);
    expect(instance.state.selection.$head.parent.textContent).toBe("after");
  });

  it("leaves ordinary caret movement to the editor", () => {
    const instance = mount([paragraph("before"), paragraph("after")]);
    instance.commands.setTextSelection(3);
    expect(press(instance, { key: "ArrowDown" })).toBe(false);
  });
});

describe("per-type keymap contributions", () => {
  it("fires only while that type is the selected object", () => {
    const instance = mount([paragraph("before"), mermaid, { type: "horizontal_rule" }]);
    const openSource = vi.fn(() => true);
    registerObjectKeymap(instance, "code_block", { "Mod-Enter": openSource });

    select(instance, positionOf(instance, "horizontal_rule"));
    press(instance, { key: "Enter", ctrlKey: true });
    expect(openSource).not.toHaveBeenCalled();

    select(instance, positionOf(instance, "code_block"));
    expect(press(instance, { key: "Enter", ctrlKey: true })).toBe(true);
    expect(openSource).toHaveBeenCalledOnce();
  });
});
