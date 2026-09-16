/** Composer `/` envelope: word boundary on the StarterKit schema. */
import { getSchema, type JSONContent } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vitest";

import { allowsComposerCommandTrigger } from "./command-trigger";

const schema = getSchema([StarterKit]);
const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

function docWithTrigger(content: JSONContent[], marker: string): { doc: PMNode; from: number } {
  const doc = schema.nodeFromJSON({ type: "doc", content });
  let from: number | null = null;
  doc.descendants((node, pos) => {
    if (from !== null) return false;
    if (!node.isText) return true;
    const index = node.text?.indexOf(marker) ?? -1;
    if (index >= 0) from = pos + index;
    return true;
  });
  if (from === null) throw new Error(`fixture has no ${marker}`);
  return { doc, from };
}

function opensOn(content: JSONContent[]): boolean {
  const { doc, from } = docWithTrigger(content, "/");
  return allowsComposerCommandTrigger(doc, from);
}

describe("composer `/` trigger", () => {
  it("opens at the start of a paragraph", () => {
    expect(opensOn([paragraph(text("/"))])).toBe(true);
    expect(opensOn([paragraph(text("/creative-writing-modes"))])).toBe(true);
  });

  it("opens immediately after whitespace", () => {
    expect(opensOn([paragraph(text("Try /"))])).toBe(true);
  });

  it("stays plain text mid-word", () => {
    expect(opensOn([paragraph(text("chapters/"))])).toBe(false);
    expect(opensOn([paragraph(text("he said,/"))])).toBe(false);
  });

  it("opens after a hard break", () => {
    expect(opensOn([paragraph(text("line"), { type: "hardBreak" }, text("/"))])).toBe(true);
  });

  it("never opens inside a code fence", () => {
    expect(opensOn([{ type: "codeBlock", content: [text("/")] }])).toBe(false);
  });

  it("refuses positions outside the document", () => {
    const { doc } = docWithTrigger([paragraph(text("/"))], "/");
    expect(allowsComposerCommandTrigger(doc, -1)).toBe(false);
    expect(allowsComposerCommandTrigger(doc, doc.content.size + 5)).toBe(false);
  });
});
