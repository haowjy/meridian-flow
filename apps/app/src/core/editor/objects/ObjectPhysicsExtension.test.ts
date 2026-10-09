// @vitest-environment jsdom
import type { Editor, JSONContent } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { afterEach, describe, expect, it } from "vitest";

import { installJsdomLayout } from "@/test-support/jsdom-layout";

import {
  createStandaloneEditor,
  requireNode,
  type StandaloneEditor,
} from "@/test-support/standalone-editor";
import { SELECTED_OBJECT_CLASS } from "./ObjectPhysicsExtension";
import { selectedObject } from "./object-selection";

let fixture: StandaloneEditor | null = null;

// Arrow keys reach gapcursor, which measures the line to decide whether Down
// leaves the block. jsdom cannot measure.
installJsdomLayout();

afterEach(() => {
  fixture?.destroy();
  fixture = null;
});

const paragraph = (text: string): JSONContent => ({
  type: "paragraph",
  content: [{ type: "text", text }],
});

const cell = (text: string): JSONContent => ({
  type: "table_cell",
  content: [paragraph(text)],
});

const table: JSONContent = {
  type: "table",
  content: [
    { type: "table_row", content: [cell("Terrace"), cell("Question")] },
    { type: "table_row", content: [cell("First"), cell("Who are you?")] },
  ],
};

const mermaid: JSONContent = {
  type: "code_block",
  attrs: { language: "mermaid" },
  content: [{ type: "text", text: "graph TD;" }],
};

function mount(content: JSONContent[]): Editor {
  fixture = createStandaloneEditor({ content: { type: "doc", content } });
  return fixture.editor;
}

function positionOf(instance: Editor, type: string): number {
  return requireNode(instance, type).pos;
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

/** One printable keystroke, the way ProseMirror hears one. */
function typeCharacter(instance: Editor, character: string): void {
  instance.view.dom.dispatchEvent(
    new KeyboardEvent("keypress", {
      key: character,
      charCode: character.charCodeAt(0),
      bubbles: true,
      cancelable: true,
    }),
  );
}

function nodeCount(instance: Editor, type: string): number {
  let count = 0;
  instance.state.doc.descendants((node) => {
    if (node.type.name === type) count += 1;
    return true;
  });
  return count;
}

function blockTypes(instance: Editor): string[] {
  const types: string[] = [];
  instance.state.doc.forEach((node) => {
    types.push(node.type.name);
  });
  return types;
}

describe("Enter on a selected object", () => {
  it("never falls through to the base keymap, which would split the block", () => {
    const instance = mount([paragraph("before"), mermaid, paragraph("after")]);
    const before = blockTypes(instance);

    select(instance, positionOf(instance, "code_block"));
    expect(press(instance, { key: "Enter" })).toBe(true);

    // No lane has registered the diagram surface yet: the object is inert,
    // not a place where Enter quietly rewrites the manuscript.
    expect(blockTypes(instance)).toEqual(before);
  });
});

describe("Delete on a selected object", () => {
  it("takes the whole table rather than blanking its cells", () => {
    const instance = mount([paragraph("above"), table, paragraph("below")]);
    // The join reflex: caret at the end of the line above, Delete to pull the
    // next line up. The first press lands on the table as an object.
    instance.commands.setTextSelection("above".length + 1);

    press(instance, { key: "Delete" });
    expect(selectedObject(instance.state)?.node.type.name).toBe("table");
    // Seen before it is destroyed: the second press is the destructive one.
    expect(instance.view.dom.querySelector(`.${SELECTED_OBJECT_CLASS}`)).not.toBeNull();

    press(instance, { key: "Delete" });
    expect(blockTypes(instance)).toEqual(["paragraph", "paragraph"]);
  });
});

describe("a printable character beside a selected object", () => {
  // Closing an image's full-screen view leaves the picture node-selected, and
  // one letter used to replace it. A letter is not a destructive verb.

  it("types after the picture rather than over it", () => {
    const instance = mount([
      {
        type: "paragraph",
        content: [
          { type: "text", text: "look " },
          { type: "image", attrs: { src: "asset:2" } },
        ],
      },
      paragraph("after"),
    ]);
    select(instance, positionOf(instance, "image"));

    typeCharacter(instance, "Q");

    expect(nodeCount(instance, "image")).toBe(1);
    expect(instance.state.doc.firstChild?.textContent).toBe("look Q");
  });
});
