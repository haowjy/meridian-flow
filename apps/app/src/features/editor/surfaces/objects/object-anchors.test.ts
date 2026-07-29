// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";

import { objectSurfaceAt, objectSurfaceAtPos } from "./object-anchors";

vi.mock("@lingui/core/macro", () => ({
  t: (parts: TemplateStringsArray) => parts.join(""),
}));

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.replaceChildren();
});

function mount(): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  editor = new Editor({
    element,
    extensions: createStandaloneEditorExtensions(),
    content: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
        {
          type: "code_block",
          attrs: { language: "mermaid" },
          content: [{ type: "text", text: "flowchart LR\nA --> B" }],
        },
        {
          type: "code_block",
          attrs: { language: "typescript" },
          content: [{ type: "text", text: "const answer = 42;" }],
        },
        { type: "horizontal_rule" },
      ],
    },
  });
  return editor;
}

/** Every block's position, keyed by the node type and language it carries. */
function positions(mounted: Editor): Map<string, number> {
  const found = new Map<string, number>();
  mounted.state.doc.descendants((node, pos) => {
    const key =
      node.type.name === "code_block" ? `code_block:${node.attrs.language}` : node.type.name;
    if (!found.has(key)) found.set(key, pos);
    return true;
  });
  return found;
}

describe("resolving an anchor", () => {
  it("finds the object from anything the pointer can land on inside it", () => {
    const mounted = mount();
    const pos = positions(mounted).get("code_block:typescript") ?? -1;

    const anchor = objectSurfaceAtPos(mounted.view, pos);
    expect(anchor?.kind).toBe("code");

    // The pointer lands on a token deep inside the fence, never on the block.
    const deepest = anchor?.element.querySelector("code") ?? anchor?.element;
    expect(objectSurfaceAt(mounted.view, deepest ?? null)?.pos).toBe(pos);
  });

  it("answers nothing outside the editor", () => {
    const mounted = mount();
    const stray = document.createElement("div");
    document.body.append(stray);

    expect(objectSurfaceAt(mounted.view, stray)).toBeNull();
    expect(objectSurfaceAt(mounted.view, null)).toBeNull();
  });

  it("answers nothing for a position that holds no object", () => {
    const mounted = mount();
    expect(objectSurfaceAtPos(mounted.view, positions(mounted).get("paragraph") ?? -1)).toBeNull();
  });
});
