/**
 * The §5.7 trigger truth table. Each row is a place a writer can type `/`, and
 * the spec is this list: a row that changes here changes the product's
 * contract, which is the point of moving the envelope out of a plugin config.
 *
 * The prose containers and the source refusals are the envelope `[[` shares,
 * and they live in `suggestion/trigger-envelope-test-support.ts`. What stays
 * here is what makes `/` itself: the word boundary.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import {
  docWithTrigger,
  positionsOutsideDocument,
  SHARED_TRIGGER_ENVELOPE,
} from "../suggestion/trigger-envelope-test-support";

import { allowsSlashTrigger } from "./slash-trigger";

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });

function opensOn(content: JSONContent[]): boolean {
  const { doc, from } = docWithTrigger(content, "/");
  return allowsSlashTrigger(doc, from);
}

describe("the envelope `/` shares with every suggestion trigger", () => {
  it.each(SHARED_TRIGGER_ENVELOPE)("$claim", ({ content, opens }) => {
    expect(opensOn(content("/"))).toBe(opens);
  });
});

describe("where `/` alone opens the menu", () => {
  it("opens at the start of a text block", () => {
    expect(opensOn([paragraph(text("/"))])).toBe(true);
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

  it("opens after a hard break, which starts a line", () => {
    expect(opensOn([paragraph(text("line"), { type: "hard_break" }, text("/"))])).toBe(true);
  });

  it("stays plain text against an inline image, which is neither a line start nor a space", () => {
    expect(
      opensOn([paragraph(text("a "), { type: "image", attrs: { src: "asset:1" } }, text("/"))]),
    ).toBe(false);
  });

  it("refuses positions outside the document", () => {
    const { doc } = docWithTrigger([paragraph(text("/"))], "/");
    for (const pos of positionsOutsideDocument(doc)) {
      expect(allowsSlashTrigger(doc, pos)).toBe(false);
    }
  });
});
