/**
 * Where `@` may open the reference menu: the envelope every suggestion trigger
 * shares, plus what makes `@` itself.
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

function opensOn(content: JSONContent[]): boolean {
  const { doc, from } = docWithTrigger(content, "@");
  return allowsAtTrigger(doc, from);
}

describe("the envelope `@` shares with every suggestion trigger", () => {
  it.each(SHARED_TRIGGER_ENVELOPE)("$claim", ({ content, opens }) => {
    expect(opensOn(content("@"))).toBe(opens);
  });

  it("refuses positions the document does not hold", () => {
    const { doc } = docWithTrigger([paragraph(text("@"))], "@");
    for (const position of positionsOutsideDocument(doc)) {
      expect(allowsAtTrigger(doc, position)).toBe(false);
    }
  });
});

describe("where `@` alone opens the menu", () => {
  it("opens at a word boundary, never inside a word", () => {
    expect(opensOn([paragraph(text("Ask @Kael"))])).toBe(true);
    expect(opensOn([paragraph(text("writer@example.com"))])).toBe(false);
  });

  it("stays text when a space follows it", () => {
    expect(opensOn([paragraph(text("@ the gate"))])).toBe(false);
  });
});
