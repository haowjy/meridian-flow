import { describe, expect, it } from "vitest";

import {
  canonicalContextUri,
  documentTitleFromUri,
  isDraftedScheme,
  parseContextUri,
  qualifyContextUriByHolder,
} from "./context-uri.js";

describe("parseContextUri", () => {
  it("treats Unfiled as a project namespace without Work authority", () => {
    expect(parseContextUri("unfiled://Untitled 1.md")).toMatchObject({
      ok: true,
      value: { scheme: "unfiled", path: "Untitled 1.md" },
    });
    expect(parseContextUri("unfiled://@w1/Untitled 1.md").ok).toBe(false);
    expect(canonicalContextUri("unfiled", "Untitled 1.md")).toBe("unfiled://Untitled 1.md");
  });
  it.each([
    "manuscript:////chapters//Chapter 1.md/",
  ])("canonicalizes equivalent manuscript reference %s", (reference) => {
    const parsed = parseContextUri(reference);
    expect(parsed.ok && parsed.value.normalized).toBe("manuscript://chapters/Chapter 1.md");
  });

  it("recognizes qualifier chains through normalized separators", () => {
    expect(parseContextUri("scratch:////@w1//@w2/notes.md")).toMatchObject({
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

  it("names an owner by handle after the sigil, and lists owners with the sigil alone", () => {
    expect(parseContextUri("scratch://@w3/outline.md")).toMatchObject({
      ok: true,
      value: {
        authority: { kind: "work", workHandle: "w3" },
        normalized: "scratch://@w3/outline.md",
      },
    });
    expect(parseContextUri("scratch://@c12/notes/a.md")).toMatchObject({
      ok: true,
      value: { authority: { kind: "lineage", rootThreadRef: "c12" } },
    });
    expect(parseContextUri("uploads://@c15/draft.png")).toMatchObject({
      ok: true,
      value: {
        authority: { kind: "chat", chatRef: "c15" },
        normalized: "uploads://@c15/draft.png",
      },
    });
    expect(parseContextUri("scratch://@")).toMatchObject({
      ok: true,
      value: { authority: { kind: "owners" }, normalized: "scratch://@" },
    });
    expect(parseContextUri("uploads://draft.png")).toMatchObject({
      ok: true,
      value: { authority: { kind: "contextual" }, normalized: "uploads://draft.png" },
    });
  });

  it("refuses the #875 spelling @/c12/ with the flat handle", () => {
    expect(parseContextUri("scratch://@/c12/x")).toMatchObject({
      ok: false,
      error: { reason: "Handles follow @ directly: scratch://@c12/…" },
    });
  });

  it("refuses the retired empty owner @/ and points at the listing", () => {
    for (const scheme of ["scratch", "uploads"]) {
      expect(parseContextUri(`${scheme}://@/`)).toMatchObject({
        ok: false,
        error: { reason: expect.stringContaining(`ls ${scheme}://@`) },
      });
    }
  });

  it("reserves the branch qualifier ~ until branches are addressable", () => {
    for (const uri of [
      "manuscript://~b7/Chapter 12",
      "manuscript://~/b7/Chapter 12",
      "scratch://~live/x",
      "~rewrite/a",
    ]) {
      expect(parseContextUri(uri, { barePathDefault: "manuscript" })).toMatchObject({
        ok: false,
        error: { reason: expect.stringContaining("Branches are not addressable yet") },
      });
    }
  });

  it("serializes every owner through one spelling", () => {
    expect(canonicalContextUri("uploads", "./a//b.png", { kind: "chat", chatRef: "c15" })).toBe(
      "uploads://@c15/a/b.png",
    );
    expect(
      canonicalContextUri("scratch", "./notes//a.md", { kind: "lineage", rootThreadRef: "c12" }),
    ).toBe("scratch://@c12/notes/a.md");
    expect(canonicalContextUri("scratch", "", { kind: "owners" })).toBe("scratch://@");
    expect(() =>
      canonicalContextUri("scratch", "a.png", { kind: "chat", chatRef: "c1" }),
    ).toThrow();
    expect(() =>
      canonicalContextUri("uploads", "a.png", { kind: "chat", chatRef: "w3" }),
    ).toThrow();
  });

  it("qualifies a contextual address only with the owner its holder supplies", () => {
    expect(qualifyContextUriByHolder("uploads://a.png", "uploads://@c15/b.png")).toBe(
      "uploads://@c15/a.png",
    );
    expect(qualifyContextUriByHolder("uploads://a.png", "scratch://@w1/b.md")).toBe(
      "uploads://a.png",
    );
  });

  it.each([
    "scratch://@w1/folder/@reserved/file.md",
    "scratch://@w1/@c12/file.md",
  ])("rejects reserved path segments: %s", (uri) => {
    expect(parseContextUri(uri)).toMatchObject({ ok: false });
  });

  it("refuses to serialize authorities or paths the parser rejects", () => {
    expect(() =>
      Reflect.apply(canonicalContextUri, undefined, [
        "manuscript",
        "chapter.md",
        { kind: "owners" },
      ]),
    ).toThrow(/does not support authority/);
    expect(() => canonicalContextUri("scratch", "folder/@reserved/file.md")).toThrow(/reserved/);
    expect(() => canonicalContextUri("scratch", "../secret.md", { kind: "owners" })).toThrow();
  });
});

describe("documentTitleFromUri", () => {
  it("is the stored name, with no extension stripped on its own", () => {
    expect(documentTitleFromUri("manuscript://Chapter 13")).toBe("Chapter 13");
    expect(documentTitleFromUri("manuscript://Book/Vol. 2")).toBe("Vol. 2");
    expect(documentTitleFromUri("scratch://@c12/outline.json")).toBe("outline.json");
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
