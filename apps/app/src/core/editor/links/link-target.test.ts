import { describe, expect, it } from "vitest";

import { classifyLinkTarget, linkTargetLabel, normalizeLinkHref } from "./link-target";

describe("normalizeLinkHref", () => {
  it.each([
    "Chapter 13",
    "The Second Gate",
    "ch12",
    "../Arc 2/Chapter 1",
    "Chapter 13#scene",
  ])("keeps the extensionless document name %s internal", (written) => {
    expect(normalizeLinkHref(written)).toBe(written);
    expect(classifyLinkTarget(normalizeLinkHref(written) ?? "")?.kind).toBe("relative");
  });

  it.each([
    "Vol. 2",
    "Chapter 1.5 Gate",
    "Dr. Who and the Gate",
  ])("keeps the dotted document name %s internal", (written) => {
    expect(normalizeLinkHref(written)).toBe(written);
  });

  it.each([
    "chapter-213.md",
    "notes.txt",
    "outline.json",
    "map.png",
    "Arc 1/outline.json#top",
  ])("keeps the registered file name %s internal", (written) => {
    expect(normalizeLinkHref(written)).toBe(written);
  });

  it("still sends a bare hostname to the web", () => {
    expect(normalizeLinkHref("example.com")).toBe("https://example.com");
    expect(normalizeLinkHref("example.com/chapter")).toBe("https://example.com/chapter");
  });

  it("keeps a Context URI and a scheme URL as written", () => {
    expect(normalizeLinkHref("manuscript://The Second Gate")).toBe("manuscript://The Second Gate");
    expect(normalizeLinkHref("https://example.com")).toBe("https://example.com");
  });
});

describe("linkTargetLabel", () => {
  it("names an internal target by its stored name", () => {
    expect(linkTargetLabel({ kind: "relative", path: "ch12" })).toBe("ch12");
    expect(linkTargetLabel({ kind: "relative", path: "ch12.md" })).toBe("ch12");
    expect(linkTargetLabel({ kind: "relative", path: "Arc%201/The%20Second%20Gate" })).toBe(
      "The Second Gate",
    );
    expect(linkTargetLabel({ kind: "scheme", uri: "manuscript://Book/outline.json" })).toBe(
      "outline.json",
    );
    expect(linkTargetLabel({ kind: "scheme", uri: "manuscript://Vol. 2#scene" })).toBe(
      "Vol. 2#scene",
    );
  });

  it("shows an external target's URL", () => {
    expect(linkTargetLabel({ kind: "external", url: "https://example.com/" })).toBe(
      "https://example.com/",
    );
  });
});
