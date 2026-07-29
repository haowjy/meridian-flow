/**
 * The §5.7 trigger truth table. Each row is a place a writer can type `/`, and
 * the spec is this list: a row that changes here changes the product's
 * contract, which is the point of moving the envelope out of a plugin config.
 */
import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import { createStandaloneEditorExtensions } from "../../config";
import { allowsSlashTrigger } from "./slash-trigger";

const schema = getSchema(createStandaloneEditorExtensions());

/** Builds a doc and returns it with the position of the `/` a writer just typed. */
function docWithSlash(content: JSONContent[]): { doc: PMNode; from: number } {
  const doc = schema.nodeFromJSON({ type: "doc", content });
  let from: number | null = null;
  doc.descendants((node, pos) => {
    if (from !== null) return false;
    if (!node.isText) return true;
    const index = node.text?.indexOf("/") ?? -1;
    if (index >= 0) from = pos + index;
    return true;
  });
  if (from === null) throw new Error("fixture has no slash");
  return { doc, from };
}

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const cell = (...content: JSONContent[]): JSONContent => ({ type: "table_cell", content });

function opensOn(content: JSONContent[]): boolean {
  const { doc, from } = docWithSlash(content);
  return allowsSlashTrigger(doc, from);
}

describe("slash trigger envelope", () => {
  it("opens at the start of a text block", () => {
    expect(opensOn([paragraph(text("/"))])).toBe(true);
    expect(opensOn([{ type: "heading", attrs: { level: 2 }, content: [text("/")] }])).toBe(true);
    // An empty paragraph is not required: the writer may be typing in front of
    // a sentence they already wrote.
    expect(opensOn([paragraph(text("/the rest of the line"))])).toBe(true);
  });

  it("opens immediately after whitespace", () => {
    expect(opensOn([paragraph(text("The Warden said nothing. /"))])).toBe(true);
  });

  it("stays plain text mid-word", () => {
    expect(opensOn([paragraph(text("chapters/"))])).toBe(false);
    // Punctuation is not whitespace: `he said,/` is still inside a word run.
    expect(opensOn([paragraph(text("he said,/"))])).toBe(false);
  });

  it("opens in list items, quotes, and table cells", () => {
    expect(
      opensOn([
        {
          type: "bullet_list",
          content: [{ type: "list_item", content: [paragraph(text("/"))] }],
        },
      ]),
    ).toBe(true);
    expect(opensOn([{ type: "blockquote", content: [paragraph(text("She wrote /"))] }])).toBe(true);
    expect(
      opensOn([
        {
          type: "table",
          content: [
            {
              type: "table_row",
              content: [cell(paragraph(text("/"))), cell(paragraph()), cell(paragraph())],
            },
          ],
        },
      ]),
    ).toBe(true);
  });

  it("never opens inside source: a code fence, a diagram's fence, a component", () => {
    expect(opensOn([{ type: "code_block", content: [text("/")] }])).toBe(false);
    expect(
      opensOn([{ type: "code_block", attrs: { language: "mermaid" }, content: [text("/")] }]),
    ).toBe(false);
    expect(opensOn([{ type: "jsx_leaf", attrs: { name: "Stat" }, content: [text("/")] }])).toBe(
      false,
    );
  });

  it("opens after a hard break, which starts a line", () => {
    expect(opensOn([paragraph(text("line"), { type: "hard_break" }, text("/"))])).toBe(true);
  });

  it("stays plain text against an inline image, which is neither a line start nor a space", () => {
    expect(
      opensOn([paragraph(text("a "), { type: "image", attrs: { src: "asset:1" } }, text("/"))]),
    ).toBe(false);
  });

  it("refuses positions outside the document", () => {
    const { doc } = docWithSlash([paragraph(text("/"))]);
    expect(allowsSlashTrigger(doc, -1)).toBe(false);
    expect(allowsSlashTrigger(doc, doc.content.size + 5)).toBe(false);
  });
});
