import { describe, expect, it } from "vitest";

import { documentTitleFromUri, parseContextUri } from "./context-uri.js";

describe("documentTitleFromUri", () => {
  it.each([
    ["manuscript://chapters/Chapter 3 — Ashes of the Vale.md", "Chapter 3 — Ashes of the Vale"],
    ["kb://characters/Elara.mdx", "Elara"],
    ["scratch://plans/next-chapter.txt", "next-chapter"],
    ["uploads://references/map.png", "map"],
    ["user://style/voice.notes.md", "voice.notes"],
    ["chapters/opening.md", "opening"],
  ])("derives the basename stem from %s", (uri, expected) => {
    expect(documentTitleFromUri(uri)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    "",
    "manuscript://",
    "manuscript://chapters/.md",
  ])("returns null when %s has no usable title", (uri) => {
    expect(documentTitleFromUri(uri)).toBeNull();
  });
});

describe("parseContextUri", () => {
  it.each([
    "/chapters/Chapter 1.md",
    "chapters/Chapter 1.md",
    "manuscript://chapters/./Chapter 1.md",
    "manuscript:////chapters//Chapter 1.md/",
  ])("canonicalizes equivalent manuscript reference %s", (reference) => {
    const parsed = parseContextUri(reference);
    expect(parsed.ok && parsed.value.canonical).toBe("manuscript://chapters/Chapter 1.md");
  });
});
