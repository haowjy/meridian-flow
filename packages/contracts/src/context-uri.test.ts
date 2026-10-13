import { describe, expect, it } from "vitest";

import {
  canonicalContextUri,
  documentTitleFromUri,
  isDraftedScheme,
  parseContextUri,
} from "./context-uri.js";

describe("parseContextUri", () => {
  it("treats Unfiled as a project namespace without Work authority", () => {
    expect(parseContextUri("unfiled://Untitled 1.md")).toMatchObject({
      ok: true,
      value: { scheme: "unfiled", path: "Untitled 1.md" },
    });
    expect(parseContextUri("unfiled://@work/Untitled 1.md").ok).toBe(false);
    expect(canonicalContextUri("unfiled", "Untitled 1.md")).toBe("unfiled://Untitled 1.md");
  });
  it.each([
    "manuscript:////chapters//Chapter 1.md/",
  ])("canonicalizes equivalent manuscript reference %s", (reference) => {
    const parsed = parseContextUri(reference);
    expect(parsed.ok && parsed.value.normalized).toBe("manuscript://chapters/Chapter 1.md");
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
    // A chat's Scratch is named by its first chat's handle: `@/` plus the handle, never `@/` alone.
    expect(parseContextUri("scratch://@/c12/notes/a.md")).toMatchObject({
      ok: true,
      value: {
        authority: { kind: "lineage", rootThreadRef: "c12" },
        normalized: "scratch://@/c12/notes/a.md",
      },
    });
    expect(
      canonicalContextUri("scratch", "./notes//a.md", { kind: "lineage", rootThreadRef: "c12" }),
    ).toBe("scratch://@/c12/notes/a.md");
    expect(() => canonicalContextUri("scratch", "a.md", { kind: "none" })).toThrow();
  });

  it.each([
    "scratch://@revision-pass/folder/@reserved/file.md",
    "scratch://@bad_slug/file.md",
    "scratch://@other/@/c12/file.md",
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
});

describe("documentTitleFromUri", () => {
  it("is the stored name, with no extension stripped on its own", () => {
    expect(documentTitleFromUri("manuscript://Chapter 13")).toBe("Chapter 13");
    expect(documentTitleFromUri("manuscript://Book/Vol. 2")).toBe("Vol. 2");
    expect(documentTitleFromUri("scratch://@/c12/outline.json")).toBe("outline.json");
    expect(documentTitleFromUri("kb://maps/map.png")).toBe("map.png");
    expect(documentTitleFromUri("user://config.toml")).toBe("config.toml");
  });

  it("canonicalizes a name someone typed with a prose suffix", () => {
    expect(documentTitleFromUri("ch12.md")).toBe("ch12");
    expect(documentTitleFromUri("manuscript://Book/notes.txt")).toBe("notes");
    expect(documentTitleFromUri("manuscript://Book/Pic.PNG")).toBe("Pic.png");
  });

  it("is null for nothing to name", () => {
    expect(documentTitleFromUri(null)).toBeNull();
    expect(documentTitleFromUri("manuscript://")).toBeNull();
  });
});

it("preserves literal href syntax in decoded document addresses", () => {
  expect(documentTitleFromUri("manuscript://Chapter#13")).toBe("Chapter#13");
  expect(documentTitleFromUri("manuscript://Book#1/Chapter 13")).toBe("Chapter 13");
  expect(documentTitleFromUri("manuscript://Chapter?13")).toBe("Chapter?13");
});

describe("isDraftedScheme", () => {
  it("drafts the four durable namespaces", () => {
    expect(["manuscript", "kb", "user", "unfiled"].map((s) => isDraftedScheme(s as never))).toEqual(
      [true, true, true, true],
    );
  });

  it("never drafts scratch or uploads", () => {
    expect(["scratch", "uploads"].map((s) => isDraftedScheme(s as never))).toEqual([false, false]);
  });
});
