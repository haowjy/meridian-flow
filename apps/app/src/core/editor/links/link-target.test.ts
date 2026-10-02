/** The classifier and the form normalizer read hrefs the way the href module does. */
import { describe, expect, it } from "vitest";

import { classifyLinkTarget, normalizeLinkHref } from "./link-target";

describe("normalizeLinkHref", () => {
  it.each([
    ["notes/kael", "notes/kael"],
    ["kael.md", "kael.md"],
    ["../kael", "../kael"],
    ["./volume 1/chapter 1.md", "./volume 1/chapter 1.md"],
    ["example.com/x", "https://example.com/x"],
    ["example.com", "https://example.com"],
    ["kb://characters/Lin Feng.md", "kb://characters/Lin Feng.md"],
    ["KB://characters/x.md", "KB://characters/x.md"],
    ["https://example.com/a", "https://example.com/a"],
  ])("stores %s as %s", (input, href) => {
    expect(normalizeLinkHref(input)).toBe(href);
  });

  it.each(["/chapter.md", "kb:characters/x.md", "javascript:alert(1)"])("refuses %s", (input) => {
    expect(normalizeLinkHref(input)).toBeNull();
  });
});

describe("classifyLinkTarget", () => {
  it("calls a Context URI internal in any case, and only with `://`", () => {
    expect(classifyLinkTarget("MANUSCRIPT://a.md")).toEqual({
      kind: "scheme",
      uri: "MANUSCRIPT://a.md",
    });
    expect(classifyLinkTarget("kb:characters/x.md")).toBeNull();
    expect(classifyLinkTarget("foo/bar://x.md")).toEqual({
      kind: "relative",
      path: "foo/bar://x.md",
    });
  });
});
