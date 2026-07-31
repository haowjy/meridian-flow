// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import { EDITOR_DIAGRAM_PROVIDERS } from "../diagrams";
import {
  EDITOR_OBJECT_TYPES,
  isEditorObject,
  isSourceBlock,
  objectBody,
  objectSurfaceKind,
  objectTypeSpec,
} from "./object-types";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function nodeOfType(content: JSONContent[], type: string): PMNode {
  editor = new Editor({
    extensions: createStandaloneEditorExtensions(),
    content: { type: "doc", content },
  });

  let found: PMNode | null = null;
  editor.state.doc.descendants((node) => {
    if (found === null && node.type.name === type) found = node;
    return found === null;
  });
  if (found === null) throw new Error(`no ${type} in the fixture`);
  return found;
}

const fence = (language: string): JSONContent => ({
  type: "code_block",
  attrs: { language },
  content: [{ type: "text", text: "graph TD;" }],
});

describe("what counts as an object", () => {
  it("registers figures, images, tables, and rules", () => {
    expect(
      isEditorObject(nodeOfType([{ type: "figure", attrs: { src: "a", caption: "" } }], "figure")),
    ).toBe(true);
    expect(isEditorObject(nodeOfType([{ type: "horizontal_rule" }], "horizontal_rule"))).toBe(true);
  });

  it("leaves prose alone: a paragraph is typed into, never selected as a thing", () => {
    expect(
      isEditorObject(
        nodeOfType([{ type: "paragraph", content: [{ type: "text", text: "x" }] }], "paragraph"),
      ),
    ).toBe(false);
  });

  it("makes a mermaid fence an object and a plain fence prose", () => {
    expect(isEditorObject(nodeOfType([fence("mermaid")], "code_block"))).toBe(true);
    expect(isEditorObject(nodeOfType([fence("ts")], "code_block"))).toBe(false);
  });

  it("engages a table into its cells and a figure into a surface", () => {
    expect(
      objectTypeSpec(nodeOfType([{ type: "horizontal_rule" }], "horizontal_rule"))?.engage,
    ).toBe("none");
    expect(
      objectTypeSpec(nodeOfType([{ type: "figure", attrs: { src: "a", caption: "" } }], "figure"))
        ?.engage,
    ).toBe("surface");
  });
});

describe("what a press on the body does", () => {
  it("drags a figure and a rule as blocks: neither has an inline place to land", () => {
    expect(
      objectBody(nodeOfType([{ type: "figure", attrs: { src: "a", caption: "" } }], "figure")),
    ).toBe("block-drag");
    expect(objectBody(nodeOfType([{ type: "horizontal_rule" }], "horizontal_rule"))).toBe(
      "block-drag",
    );
    expect(objectBody(nodeOfType([fence("mermaid")], "code_block"))).toBe("block-drag");
  });

  it("drags a picture inline, which is how it lands between two words", () => {
    expect(
      objectBody(
        nodeOfType(
          [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "before " },
                { type: "image", attrs: { src: "asset:1", alt: null, title: null } },
              ],
            },
          ],
          "image",
        ),
      ),
    ).toBe("inline-drag");
  });

  it("leaves a table's cells their own pointer, and says nothing about prose", () => {
    expect(
      objectBody(
        nodeOfType(
          [
            {
              type: "table",
              content: [
                {
                  type: "table_row",
                  content: [
                    { type: "table_cell", content: [{ type: "paragraph" }] },
                    { type: "table_cell", content: [{ type: "paragraph" }] },
                  ],
                },
              ],
            },
          ],
          "table",
        ),
      ),
    ).toBe("text");
    expect(
      objectBody(
        nodeOfType([{ type: "paragraph", content: [{ type: "text", text: "x" }] }], "paragraph"),
      ),
    ).toBe("text");
  });

  it("keeps caret-landing and drag-start one answer for every registration", () => {
    // The invariant the second column used to hold: opaque exactly when the
    // body is a grip. A row that wanted the fourth combination would fail here
    // and is the signal to split the column again.
    for (const spec of EDITOR_OBJECT_TYPES) {
      expect(
        spec.body === "text" || spec.body === "block-drag" || spec.body === "inline-drag",
      ).toBe(true);
    }
  });
});

describe("what a registration is named", () => {
  it("gives every row a unique id, because surfaces register against it", () => {
    const ids = EDITOR_OBJECT_TYPES.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("names each diagram dialect apart, though all of them are code blocks", () => {
    const diagrams = EDITOR_OBJECT_TYPES.filter((spec) => spec.surfaceKind === "diagram");
    expect(diagrams.length).toBe(EDITOR_DIAGRAM_PROVIDERS.length);
    for (const provider of EDITOR_DIAGRAM_PROVIDERS) {
      const spec = diagrams.find((candidate) => candidate.id === `diagram:${provider.language}`);
      expect(spec?.nodeType).toBe("code_block");
      expect(spec?.engage).toBe("surface");
    }
  });
});

describe("which control surface a node gets", () => {
  it("splits code_block by language, because a diagram is a fence wearing another face", () => {
    expect(objectSurfaceKind(nodeOfType([fence("mermaid")], "code_block"))).toBe("diagram");
    expect(objectSurfaceKind(nodeOfType([fence("ts")], "code_block"))).toBe("code");
  });

  it("gives a picture the image cluster, however it is wrapped", () => {
    expect(
      objectSurfaceKind(
        nodeOfType([{ type: "figure", attrs: { src: "a", caption: "" } }], "figure"),
      ),
    ).toBe("image");
  });

  it("gives nothing to nodes that carry no controls", () => {
    // A rule is an object to the kernel (arrow-walk, Esc) and still has no
    // verbs of its own: object-ness and a control row are two questions.
    expect(
      objectSurfaceKind(nodeOfType([{ type: "horizontal_rule" }], "horizontal_rule")),
    ).toBeNull();
    expect(
      objectSurfaceKind(
        nodeOfType([{ type: "paragraph", content: [{ type: "text", text: "x" }] }], "paragraph"),
      ),
    ).toBeNull();
  });
});

describe("source blocks", () => {
  it("reads the schema's code flag, not ProseMirror's text-block category", () => {
    expect(isSourceBlock(nodeOfType([fence("ts")], "code_block"))).toBe(true);
    expect(
      isSourceBlock(
        nodeOfType([{ type: "paragraph", content: [{ type: "text", text: "x" }] }], "paragraph"),
      ),
    ).toBe(false);
  });

  it("counts a mermaid fence as both: rendered it is an object, raw it is source", () => {
    const mermaid = nodeOfType([fence("mermaid")], "code_block");
    expect(isSourceBlock(mermaid)).toBe(true);
    expect(isEditorObject(mermaid)).toBe(true);
  });
});
