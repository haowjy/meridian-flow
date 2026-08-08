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

  it("parses one Work qualifier without resolving its raw slug", () => {
    expect(parseContextUri("scratch://@Revision-Pass/notes.md")).toEqual({
      ok: true,
      value: {
        scheme: "scratch",
        authority: "Revision-Pass",
        path: "notes.md",
        canonical: "scratch://@Revision-Pass/notes.md",
      },
    });
  });

  it("rejects qualifier chains instead of reading the second qualifier as a name", () => {
    expect(parseContextUri("scratch://@other-project/@revision-pass/notes.md")).toEqual({
      ok: false,
      error: {
        uri: "scratch://@other-project/@revision-pass/notes.md",
        reason: 'Authority qualifier chains are not yet supported for scheme "scratch"',
      },
    });
  });

  it("recognizes qualifier chains through normalized separators", () => {
    expect(parseContextUri("scratch:////@other-project//@revision-pass/notes.md")).toMatchObject({
      ok: false,
      error: { reason: expect.stringContaining("not yet supported") },
    });
  });

  it("treats an unmarked UUID-shaped segment as a legal filename", () => {
    expect(
      parseContextUri("scratch://00000000-0000-4000-8000-000000000001/notes.md"),
    ).toMatchObject({
      ok: true,
      value: {
        authority: null,
        path: "00000000-0000-4000-8000-000000000001/notes.md",
      },
    });
  });
});
