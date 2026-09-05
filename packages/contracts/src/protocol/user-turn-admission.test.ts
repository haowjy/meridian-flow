/** Exact persisted reference-occurrence recognition for transcript consumers. */
import { describe, expect, it } from "vitest";
import { referenceOccurrenceContent } from "./user-turn-admission.js";

const occurrence = {
  type: "reference",
  text: "[[Gate Map]]",
  documentId: "33333333-3333-4333-8333-333333333333",
  uri: "uploads://@/gate-map.png",
};

describe("referenceOccurrenceContent", () => {
  it("recognizes only exact structured text-block content", () => {
    expect(referenceOccurrenceContent({ blockType: "text", content: occurrence })).toEqual(
      occurrence,
    );
    expect(
      referenceOccurrenceContent({ blockType: "text", content: { ...occurrence, extra: true } }),
    ).toBeNull();
    expect(referenceOccurrenceContent({ blockType: "image", content: occurrence })).toBeNull();
    expect(
      referenceOccurrenceContent({
        blockType: "text",
        content: { ...occurrence, documentId: "not-an-id" },
      }),
    ).toBeNull();
    expect(
      referenceOccurrenceContent({
        blockType: "text",
        content: { ...occurrence, uri: "uploads://@//gate-map.png" },
      }),
    ).toBeNull();
  });
});
