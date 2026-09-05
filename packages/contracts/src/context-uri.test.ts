import { describe, expect, it } from "vitest";

import { canonicalContextUri, documentTitleFromUri, parseContextUri } from "./context-uri.js";

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
    expect(parsed.ok && parsed.value.normalized).toBe("manuscript://chapters/Chapter 1.md");
  });

  it("parses one Work qualifier without resolving its raw slug", () => {
    expect(parseContextUri("scratch://@Revision-Pass/notes.md")).toEqual({
      ok: true,
      value: {
        scheme: "scratch",
        authority: { kind: "work", workSlug: "Revision-Pass" },
        path: "notes.md",
        normalized: "scratch://@Revision-Pass/notes.md",
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
        authority: { kind: "contextual" },
        path: "00000000-0000-4000-8000-000000000001/notes.md",
      },
    });
  });

  it("accepts UUID-shaped Work slug syntax without inferring an ID", () => {
    const workSlug = "123e4567-e89b-12d3-a456-426614174000";
    expect(parseContextUri(`scratch://@${workSlug}/notes.md`)).toMatchObject({
      ok: true,
      value: { authority: { kind: "work", workSlug } },
    });
  });

  it("distinguishes contextual, explicit Work, and explicit no-Work authority", () => {
    expect(parseContextUri("uploads://draft.png")).toMatchObject({
      ok: true,
      value: { authority: { kind: "contextual" }, normalized: "uploads://draft.png" },
    });
    expect(parseContextUri("uploads://@revision-pass/draft.png")).toMatchObject({
      ok: true,
      value: {
        authority: { kind: "work", workSlug: "revision-pass" },
        normalized: "uploads://@revision-pass/draft.png",
      },
    });
    expect(parseContextUri("uploads://@/draft.png")).toMatchObject({
      ok: true,
      value: { authority: { kind: "none" }, normalized: "uploads://@/draft.png" },
    });
  });

  it.each([
    ["scratch://", "scratch://"],
    ["scratch://notes/a.md", "scratch://notes/a.md"],
    ["scratch://@revision-pass/", "scratch://@revision-pass/"],
    ["scratch://@revision-pass/notes/a.md", "scratch://@revision-pass/notes/a.md"],
    ["scratch://@/", "scratch://@/"],
    ["scratch://@/notes/a.md", "scratch://@/notes/a.md"],
  ])("round trips every Work-capable authority form: %s", (uri, normalized) => {
    const parsed = parseContextUri(uri);
    expect(parsed).toMatchObject({ ok: true, value: { normalized } });
  });

  it.each([
    "scratch://folder/@reserved/file.md",
    "scratch://@revision-pass/folder/@reserved/file.md",
    "manuscript://folder/@reserved/file.md",
    "scratch://@bad_slug/file.md",
    "scratch://@-bad/file.md",
  ])("rejects reserved path segments and invalid authorities: %s", (uri) => {
    expect(parseContextUri(uri)).toMatchObject({ ok: false });
  });

  it("refuses to serialize authorities or paths the parser rejects", () => {
    expect(() =>
      Reflect.apply(canonicalContextUri, undefined, ["manuscript", "chapter.md", { kind: "none" }]),
    ).toThrow(/does not support authority/);
    expect(() => canonicalContextUri("scratch", "folder/@reserved/file.md")).toThrow(/reserved/);
    expect(() => canonicalContextUri("scratch", "../secret.md", { kind: "none" })).toThrow();
  });

  it.each([
    ["/notes.md", "scratch://@/notes.md"],
    ["notes//draft.md", "scratch://@/notes/draft.md"],
    ["./notes/./draft.md", "scratch://@/notes/draft.md"],
  ])("normalizes serializer input %s and round trips", (path, expected) => {
    const uri = canonicalContextUri("scratch", path, { kind: "none" });
    expect(uri).toBe(expected);
    expect(parseContextUri(uri)).toMatchObject({ ok: true, value: { normalized: uri } });
  });
});
