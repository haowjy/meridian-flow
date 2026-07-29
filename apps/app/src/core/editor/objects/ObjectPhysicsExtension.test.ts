// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installJsdomLayout } from "@/test-support/jsdom-layout";

import { createStandaloneEditorExtensions } from "../config";
import {
  engageObject,
  registerObjectEngagement,
  registerObjectKeymap,
} from "./ObjectPhysicsExtension";

let editor: Editor | null = null;

// Arrow keys reach gapcursor, which measures the line to decide whether Down
// leaves the block. jsdom cannot measure.
installJsdomLayout();

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

/** A real mouse press on `element`, and whether anything refused its default. */
function mouseDown(element: Element, init: MouseEventInit = {}): boolean {
  const event = new MouseEvent("mousedown", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  element.dispatchEvent(event);
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

  it("puts the caret at the start of a selected plain fence (§4)", () => {
    const plainFence: JSONContent = {
      type: "code_block",
      attrs: { language: "ts" },
      content: [{ type: "text", text: "const gate = 3;" }],
    };
    const instance = mount([paragraph("before"), plainFence, paragraph("after")]);
    const before = blockTypes(instance);

    select(instance, positionOf(instance, "code_block"));
    expect(press(instance, { key: "Enter" })).toBe(true);

    // Not the base keymap's answer, which appends a paragraph after the fence
    // and leaves the caret in it — a structural edit from a key that was
    // supposed to take the writer INTO the code.
    expect(blockTypes(instance)).toEqual(before);
    expect(instance.state.selection.empty).toBe(true);
    expect(instance.state.selection.$head.parent.type.name).toBe("code_block");
    expect(instance.state.selection.from).toBe(positionOf(instance, "code_block") + 1);
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

describe("double-click engages", () => {
  it("opens the object's surface without a selection step first", () => {
    const instance = mount([paragraph("before"), mermaid]);
    const pos = positionOf(instance, "code_block");
    const opened: number[] = [];
    registerObjectEngagement(instance, "code_block", ({ pos: at }) => {
      opened.push(at);
      return true;
    });

    // §5.2's second door into the dialog: a double-click on the diagram in the
    // page, with no click-to-select beforehand.
    const node = instance.state.doc.nodeAt(pos);
    if (!node) throw new Error("no diagram in the fixture");
    const handled = instance.view.someProp("handleDoubleClickOn", (handler) =>
      handler(instance.view, pos + 1, node, pos, new MouseEvent("dblclick"), true),
    );

    expect(handled).toBe(true);
    expect(opened).toEqual([pos]);
  });

  it("leaves a double-click in prose to the browser's word selection", () => {
    const instance = mount([paragraph("before"), mermaid]);
    const pos = positionOf(instance, "paragraph");
    const node = instance.state.doc.nodeAt(pos);
    if (!node) throw new Error("no paragraph in the fixture");

    const handled = instance.view.someProp("handleDoubleClickOn", (handler) =>
      handler(instance.view, pos + 1, node, pos, new MouseEvent("dblclick"), true),
    );

    expect(handled).toBeFalsy();
  });
});

describe("why a surface is opening", () => {
  /** Records the opening each door reports, so the two can be told apart. */
  function captureOpenings(instance: Editor): string[] {
    const openings: string[] = [];
    registerObjectEngagement(instance, "code_block", (_target, opening) => {
      openings.push(opening);
      return true;
    });
    return openings;
  }

  it("says a just-created object has nothing to view yet", () => {
    const instance = mount([paragraph("before"), mermaid]);
    const openings = captureOpenings(instance);
    const pos = positionOf(instance, "code_block");
    const node = instance.state.doc.nodeAt(pos);
    if (!node) throw new Error("no diagram in the fixture");

    // Law 2's exception: the lane that made it asks for the surface, and the
    // surface has to know it is opening on something nobody has read yet.
    engageObject(instance, { node, pos }, "created");

    expect(openings).toEqual(["created"]);
  });

  it("says an existing object is being engaged", () => {
    const instance = mount([paragraph("before"), mermaid]);
    const openings = captureOpenings(instance);
    const pos = positionOf(instance, "code_block");
    const node = instance.state.doc.nodeAt(pos);
    if (!node) throw new Error("no diagram in the fixture");

    select(instance, pos);
    press(instance, { key: "Enter" });
    instance.view.someProp("handleDoubleClickOn", (handler) =>
      handler(instance.view, pos + 1, node, pos, new MouseEvent("dblclick"), true),
    );

    expect(openings).toEqual(["engage", "engage"]);
  });
});

describe("a press on an object body", () => {
  // The rule is the DOM's own: a body marked `contenteditable="false"` takes
  // the press, because `handleClickOn` is a mouseup path and the browser has
  // already answered the press by then. Only a node view that hides its own
  // text produces such a body, so the positive case lives with the one that
  // does (`MermaidCodeBlock.test.tsx`); what belongs here is everything the
  // rule must keep its hands off.

  it("leaves a plain fence its caret: the press lands in editable text", () => {
    // §5.3: a code block's rendering IS its source, so a click places a caret
    // and there is no hidden mode to fall into.
    const instance = mount([
      { type: "code_block", content: [{ type: "text", text: "const qi = 1;" }] },
    ]);
    const fence = instance.view.dom.querySelector("pre");
    if (!fence) throw new Error("expected a fence");

    expect(mouseDown(fence)).toBe(false);
    expect(instance.state.selection).not.toBeInstanceOf(NodeSelection);
  });

  it("leaves a table cell its caret", () => {
    const instance = mount([
      {
        type: "table",
        content: [
          {
            type: "table_row",
            content: [{ type: "table_cell", content: [paragraph("cell")] }],
          },
        ],
      },
    ]);
    const cell = instance.view.dom.querySelector("td");
    if (!cell) throw new Error("expected a cell");

    expect(mouseDown(cell)).toBe(false);
  });
});
