/** Exact persisted reference-occurrence recognition for transcript consumers. */
import { describe, expect, it } from "vitest";
import { referenceOccurrenceContent, skillOccurrenceContent } from "./user-turn-admission.js";

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

const skill = {
  type: "skill",
  text: "/writing-principles",
  slug: "writing-principles",
  name: "Writing principles",
  description: "Reader reward.",
};

describe("skillOccurrenceContent", () => {
  it("recognizes only exact structured text-block content", () => {
    expect(skillOccurrenceContent({ blockType: "text", content: skill })).toEqual(skill);
    expect(
      skillOccurrenceContent({ blockType: "text", content: { ...skill, extra: true } }),
    ).toBeNull();
    expect(skillOccurrenceContent({ blockType: "image", content: skill })).toBeNull();
    expect(
      skillOccurrenceContent({
        blockType: "text",
        content: { ...skill, text: "/other" },
      }),
    ).toBeNull();
  });
});

it("keeps reference identity recognizable after a server read snapshot is added", () => {
  const content = {
    ...occurrence,
    read: { result: { command: "read", status: "document_not_found" } },
  };
  expect(referenceOccurrenceContent({ blockType: "text", content })).toEqual(content);
  expect(
    referenceOccurrenceContent({ blockType: "text", content: { ...occurrence, read: "fake" } }),
  ).toBeNull();
});
