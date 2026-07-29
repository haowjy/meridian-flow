/**
 * The §5.5 `[[` truth table. Each row is a place a writer can type two
 * brackets, and the list is the contract: a wikilink is what an LLM emits, so
 * a place the trigger silently refuses is a place the writer and the model
 * disagree about what the manuscript accepts.
 */
import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../../config";
import { allowsWikilinkTrigger } from "./wikilink-trigger";

const schema = getSchema(createStandaloneEditorExtensions());

/** Builds a doc and returns it with the position of the first `[` typed. */
function docWithBrackets(content: JSONContent[]): { doc: PMNode; from: number } {
  const doc = schema.nodeFromJSON({ type: "doc", content });
  let from: number | null = null;
  doc.descendants((node, pos) => {
    if (from !== null) return false;
    if (!node.isText) return true;
    const index = node.text?.indexOf("[[") ?? -1;
    if (index >= 0) from = pos + index;
    return true;
  });
  if (from === null) throw new Error("fixture has no brackets");
  return { doc, from };
}

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const cell = (...content: JSONContent[]): JSONContent => ({ type: "table_cell", content });
const linked = (value: string, href: string): JSONContent => ({
  type: "text",
  text: value,
  marks: [{ type: "link", attrs: { href, title: null } }],
});

function opensOn(content: JSONContent[]): boolean {
  const { doc, from } = docWithBrackets(content);
  return allowsWikilinkTrigger(doc, from);
}

describe("the `[[` trigger envelope", () => {
  it("opens anywhere in prose, including mid-word and against punctuation", () => {
    expect(opensOn([paragraph(text("[["))])).toBe(true);
    expect(opensOn([paragraph(text("She checked the seal against [["))])).toBe(true);
    // Two brackets are already an unambiguous request, so unlike `/` there is
    // no word boundary to respect: a wikilink follows an opening quote or
    // parenthesis with nothing between constantly.
    expect(opensOn([paragraph(text('("[['))])).toBe(true);
    expect(opensOn([{ type: "heading", attrs: { level: 2 }, content: [text("[[")] }])).toBe(true);
  });

  it("opens in list items, quotes, and table cells", () => {
    expect(
      opensOn([
        { type: "bullet_list", content: [{ type: "list_item", content: [paragraph(text("[["))] }] },
      ]),
    ).toBe(true);
    expect(opensOn([{ type: "blockquote", content: [paragraph(text("see [["))] }])).toBe(true);
    expect(
      opensOn([
        {
          type: "table",
          content: [
            {
              type: "table_row",
              content: [cell(paragraph(text("[["))), cell(paragraph()), cell(paragraph())],
            },
          ],
        },
      ]),
    ).toBe(true);
  });

  it("never opens inside source: a code fence, a diagram's fence, a component", () => {
    expect(opensOn([{ type: "code_block", content: [text("[[")] }])).toBe(false);
    expect(
      opensOn([{ type: "code_block", attrs: { language: "mermaid" }, content: [text("[[")] }]),
    ).toBe(false);
    expect(opensOn([{ type: "jsx_leaf", attrs: { name: "Stat" }, content: [text("[[")] }])).toBe(
      false,
    );
  });

  it("stays plain text inside an existing link, where it is a correction", () => {
    // Typing inside a link's text carries the link mark, so both sides of the
    // brackets belong to the same link: this writer is fixing a destination's
    // label, not starting a new link inside it.
    expect(opensOn([paragraph(linked("The [[Gate", "https://example.com"))])).toBe(false);
  });

  it("opens at the end of a link, which the writer has already left", () => {
    // The mark is non-inclusive: what is typed here is plain prose, and a
    // wikilink right after a link is an ordinary sentence.
    expect(opensOn([paragraph(linked("The Gate", "https://example.com"), text("[["))])).toBe(true);
  });

  it("refuses positions outside the document", () => {
    const { doc } = docWithBrackets([paragraph(text("[["))]);
    expect(allowsWikilinkTrigger(doc, -1)).toBe(false);
    expect(allowsWikilinkTrigger(doc, doc.content.size + 5)).toBe(false);
  });
});
