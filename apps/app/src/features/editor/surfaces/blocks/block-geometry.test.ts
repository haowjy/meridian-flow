// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import type { EditorView } from "@tiptap/pm/view";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";

import { objectBodyDragTarget } from "./block-geometry";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

const image: JSONContent = { type: "image", attrs: { src: "asset:1", alt: null, title: null } };

const imageAlone: JSONContent = { type: "paragraph", content: [image] };

const imageInSentence: JSONContent = {
  type: "paragraph",
  content: [
    { type: "text", text: "Before the picture. " },
    image,
    { type: "text", text: " After." },
  ],
};

const rule: JSONContent = { type: "horizontal_rule" };

function mount(content: JSONContent[]): Editor {
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content },
  });
  return editor;
}

/**
 * jsdom draws nothing, so `posAtCoords` has no answer of its own. The press is
 * described directly: the position the pointer landed inside, and a DOM target
 * standing where a node view's own body stands (`contenteditable="false"`).
 */
function pressOn(
  instance: Editor,
  inside: number,
): {
  view: EditorView;
  event: PointerEvent;
} {
  const body = document.createElement("div");
  body.setAttribute("contenteditable", "false");
  const drawn = document.createElement("img");
  body.appendChild(drawn);

  const view = {
    state: instance.state,
    posAtCoords: () => ({ pos: inside, inside }),
  } as unknown as EditorView;

  return { view, event: { target: drawn, clientX: 100, clientY: 100 } as unknown as PointerEvent };
}

/** The position of the first node of `type`, which is what a press resolves to. */
function positionOf(instance: Editor, type: string): number {
  let found: number | null = null;
  instance.state.doc.descendants((node, pos) => {
    if (found === null && node.type.name === type) found = pos;
    return found === null;
  });
  if (found === null) throw new Error(`no ${type} in the fixture`);
  return found;
}

describe("which presses start a block drag", () => {
  it("grabs a picture that is alone in its paragraph", () => {
    const instance = mount([
      { type: "paragraph", content: [{ type: "text", text: "one" }] },
      imageAlone,
    ]);
    const { view, event } = pressOn(instance, positionOf(instance, "image"));

    expect(objectBodyDragTarget(view, event)?.index).toBe(1);
  });

  it("refuses a picture sitting inside a sentence: the paragraph is not what the writer grabbed", () => {
    const instance = mount([imageInSentence]);
    const { view, event } = pressOn(instance, positionOf(instance, "image"));

    expect(objectBodyDragTarget(view, event)).toBeNull();
  });

  it("still grabs a block object, which IS its block", () => {
    const instance = mount([{ type: "paragraph", content: [{ type: "text", text: "one" }] }, rule]);
    const { view, event } = pressOn(instance, positionOf(instance, "horizontal_rule"));

    expect(objectBodyDragTarget(view, event)?.index).toBe(1);
  });
});
