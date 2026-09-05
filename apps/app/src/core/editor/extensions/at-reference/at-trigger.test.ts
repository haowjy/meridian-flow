/**
 * Where `@` opens, as a truth table.
 *
 * The containers and the source refusals are the envelope every trigger shares
 * (`suggestion/trigger-envelope-test-support.ts`); the link rule is the one
 * `[[` shares. What is proven here is what makes `@` itself: the word boundary,
 * which is the whole reason an email address in a manuscript never opens a
 * menu.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import {
  docWithTrigger,
  positionsOutsideDocument,
  SHARED_TRIGGER_ENVELOPE,
} from "../suggestion/trigger-envelope-test-support";
import { allowsAtTrigger } from "./at-trigger";

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const linked = (value: string, href: string): JSONContent => ({
  type: "text",
  text: value,
  marks: [{ type: "link", attrs: { href, title: null } }],
});

function opensOn(content: JSONContent[]): boolean {
  const { doc, from } = docWithTrigger(content, "@");
  return allowsAtTrigger(doc, from);
}

describe("the envelope `@` shares with every suggestion trigger", () => {
  it.each(SHARED_TRIGGER_ENVELOPE)("$claim", ({ content, opens }) => {
    expect(opensOn(content("@"))).toBe(opens);
  });
});

describe("where `@` alone opens the menu", () => {
  it("opens at the start of a text block and after whitespace", () => {
    expect(opensOn([paragraph(text("@"))])).toBe(true);
    expect(opensOn([paragraph(text("She checked the seal against @"))])).toBe(true);
  });

  it("stays plain text mid-word, which is what an address is made of", () => {
    expect(opensOn([paragraph(text("ilsever@"))])).toBe(false);
    // Punctuation is not whitespace, so a handle quoted straight after a comma
    // is still inside the run the writer is typing.
    expect(opensOn([paragraph(text("he said,@"))])).toBe(false);
  });

  it("opens after a hard break, which starts a line", () => {
    expect(opensOn([paragraph(text("line"), { type: "hard_break" }, text("@"))])).toBe(true);
  });

  it("stays plain text against an inline image, which is neither a line start nor a space", () => {
    expect(
      opensOn([paragraph(text("a "), { type: "image", attrs: { src: "asset:1" } }, text("@"))]),
    ).toBe(false);
  });

  it("stays plain text inside an existing link, where it is a correction", () => {
    expect(opensOn([paragraph(linked("The @Gate", "https://example.com"))])).toBe(false);
  });

  it("refuses positions outside the document", () => {
    const { doc } = docWithTrigger([paragraph(text("@"))], "@");
    for (const pos of positionsOutsideDocument(doc)) {
      expect(allowsAtTrigger(doc, pos)).toBe(false);
    }
  });
});
