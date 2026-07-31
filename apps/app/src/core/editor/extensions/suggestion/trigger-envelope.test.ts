/**
 * The truth table for where a reference trigger may open — the envelope `[[`
 * and `@` share.
 *
 * Each row is a place a writer can type one, and the list is the contract: a
 * wikilink is what an LLM emits, so a place the trigger silently refuses is a
 * place the writer and the model disagree about what the manuscript accepts.
 *
 * The prose containers and the source refusals are the envelope `/` shares too,
 * and they live in `trigger-envelope-test-support.ts`. What stays here is what
 * makes a reference trigger: no word boundary in the envelope itself, and no
 * link already around it. The boundary `/` and `@` each add on top belongs to
 * their own suites.
 */
import type { JSONContent } from "@tiptap/core";
import { describe, expect, it } from "vitest";

import { allowsProseTrigger } from "./trigger-envelope";
import {
  docWithTrigger,
  positionsOutsideDocument,
  SHARED_TRIGGER_ENVELOPE,
} from "./trigger-envelope-test-support";

const text = (value: string): JSONContent => ({ type: "text", text: value });
const paragraph = (...content: JSONContent[]): JSONContent => ({ type: "paragraph", content });
const linked = (value: string, href: string): JSONContent => ({
  type: "text",
  text: value,
  marks: [{ type: "link", attrs: { href, title: null } }],
});

function opensOn(content: JSONContent[]): boolean {
  const { doc, from } = docWithTrigger(content, "[[");
  return allowsProseTrigger(doc, from);
}

describe("the envelope `[[` and `@` share with every suggestion trigger", () => {
  it.each(SHARED_TRIGGER_ENVELOPE)("$claim", ({ content, opens }) => {
    expect(opensOn(content("[["))).toBe(opens);
  });
});

describe("where a reference trigger may open", () => {
  it("opens anywhere in prose, including mid-word and against punctuation", () => {
    expect(opensOn([paragraph(text("[["))])).toBe(true);
    expect(opensOn([paragraph(text("She checked the seal against [["))])).toBe(true);
    // Two brackets are already an unambiguous request, so the shared envelope
    // asks for no word boundary: a wikilink follows an opening quote or
    // parenthesis with nothing between constantly. `@`, which is one ordinary
    // character of prose, adds the boundary back in its own lane.
    expect(opensOn([paragraph(text('("[['))])).toBe(true);
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
    const { doc } = docWithTrigger([paragraph(text("[["))], "[[");
    for (const pos of positionsOutsideDocument(doc)) {
      expect(allowsProseTrigger(doc, pos)).toBe(false);
    }
  });
});
