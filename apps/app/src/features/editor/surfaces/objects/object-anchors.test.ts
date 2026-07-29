// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createStandaloneEditorExtensions } from "@/core/editor/config";

import { objectSurfaceAt, objectSurfaceAtPos, objectSurfaceKind } from "./object-anchors";

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

describe("which surface an object gets", () => {
  it("splits code_block by language, because a diagram is a fence wearing another face", () => {
    const mounted = mount();
    const at = positions(mounted);

    const mermaid = mounted.state.doc.nodeAt(at.get("code_block:mermaid") ?? -1);
    const typescript = mounted.state.doc.nodeAt(at.get("code_block:typescript") ?? -1);

    expect(mermaid && objectSurfaceKind(mermaid)).toBe("diagram");
    expect(typescript && objectSurfaceKind(typescript)).toBe("code");
  });

  it("gives nothing to nodes that carry no controls", () => {
    const mounted = mount();
    const rule = mounted.state.doc.nodeAt(positions(mounted).get("horizontal_rule") ?? -1);
    const paragraph = mounted.state.doc.nodeAt(positions(mounted).get("paragraph") ?? -1);

    // A horizontal rule is an object to the kernel (arrow-walk, Esc) and still
    // has no verbs of its own: object-ness and a control row are two questions.
    expect(rule && objectSurfaceKind(rule)).toBeNull();
    expect(paragraph && objectSurfaceKind(paragraph)).toBeNull();
  });
});

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
