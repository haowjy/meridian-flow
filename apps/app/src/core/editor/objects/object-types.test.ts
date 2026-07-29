// @vitest-environment jsdom
import { Editor, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { afterEach, describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../config";
import {
  isEditorObject,
  isObjectBodyDragSource,
  isSourceBlock,
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

describe("which bodies a writer can grab", () => {
  it("offers a picture and a rule, and leaves a table's cells their own pointer", () => {
    expect(
      isObjectBodyDragSource(
        nodeOfType([{ type: "figure", attrs: { src: "a", caption: "" } }], "figure"),
      ),
    ).toBe(true);
    expect(
      isObjectBodyDragSource(nodeOfType([{ type: "horizontal_rule" }], "horizontal_rule")),
    ).toBe(true);
    expect(
      isObjectBodyDragSource(
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
    ).toBe(false);
  });

  it("says nothing about prose, which has no body to grab", () => {
    expect(
      isObjectBodyDragSource(
        nodeOfType([{ type: "paragraph", content: [{ type: "text", text: "x" }] }], "paragraph"),
      ),
    ).toBe(false);
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
