/**
 * What a pick spells, in the one place every surface asks.
 *
 * A second spelling for a picked document is two surfaces that disagree about
 * one meaning, so the composer's token and the manuscript's wikilink both ask
 * here — and the escape hatches (ambiguity, a title the wire format refuses)
 * have to hold for both.
 */
import { describe, expect, it } from "vitest";

import { type ReferenceDocumentItem, referenceSpelling } from "./reference-spelling";

function documentItem(
  name: string,
  overrides: Partial<ReferenceDocumentItem> = {},
): ReferenceDocumentItem {
  return {
    kind: "document",
    key: "document:doc-1",
    name,
    location: "Chapters",
    documentId: "doc-1",
    uri: "manuscript://chapters/the-third-gate.md",
    matchedAlias: null,
    ambiguous: false,
    ...overrides,
  };
}

describe("what a pick spells", () => {
  it("writes the title, which reads as prose and renders as a link", () => {
    expect(referenceSpelling(documentItem("The Third Gate"))).toBe("[[The Third Gate]]");
  });

  it("names the exact document when the title reaches two of them", () => {
    expect(referenceSpelling(documentItem("Notes", { ambiguous: true }))).toBe(
      "manuscript://chapters/the-third-gate.md",
    );
  });

  it("falls back to the URI for a title the wire format cannot carry", () => {
    // `|` is the aliased spelling this dialect does not have, so `[[…]]` would
    // round-trip as something else entirely.
    expect(referenceSpelling(documentItem("Kael|the warden"))).toBe(
      "manuscript://chapters/the-third-gate.md",
    );
  });
});
