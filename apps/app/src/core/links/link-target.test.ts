import { describe, expect, it } from "vitest";

import {
  classifyLinkTarget,
  documentLinkTarget,
  linkTargetHref,
  normalizeLinkHref,
} from "./link-target";

describe("classifyLinkTarget", () => {
  it.each([
    ["[[The Second Gate]]", { kind: "wikilink", name: "The Second Gate" }],
    ["[[ Warden Ilsever ]]", { kind: "wikilink", name: "Warden Ilsever" }],
    [
      "manuscript://appendix/vault-charter",
      { kind: "scheme", uri: "manuscript://appendix/vault-charter" },
    ],
    ["work://a1b2/notes.md", { kind: "scheme", uri: "work://a1b2/notes.md" }],
    ["kb://characters/kael.md", { kind: "scheme", uri: "kb://characters/kael.md" }],
    ["chapter-213.md", { kind: "relative", path: "chapter-213.md" }],
    ["../notes/kael.md", { kind: "relative", path: "../notes/kael.md" }],
    ["/appendix/charter.md", { kind: "relative", path: "/appendix/charter.md" }],
    [
      "https://example.com/threads/pacing",
      { kind: "external", url: "https://example.com/threads/pacing" },
    ],
    // `url` is the parser's own spelling, which is why a bare origin gains its
    // root path: that is the string the browser will navigate to.
    ["http://example.com", { kind: "external", url: "http://example.com/" }],
    ["mailto:writer@example.com", { kind: "external", url: "mailto:writer@example.com" }],
    ["//example.com/path", { kind: "external", url: "https://example.com/path" }],
  ])("classifies %s", (href, expected) => {
    expect(classifyLinkTarget(href)).toEqual(expected);
  });

  it.each([
    "",
    "   ",
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "ftp://example.com",
    "[[]]",
    "[[ ]]",
    "[[Kael|the warden]]",
    "[[unclosed",
  ])("refuses %s", (href) => {
    expect(classifyLinkTarget(href)).toBeNull();
  });

  it("keeps a bare hostname relative, because an href is not form input", () => {
    // The markdown parser never adds a scheme, so `example.com` in a document
    // is a path. The https:// convenience belongs to normalizeLinkHref alone.
    expect(classifyLinkTarget("example.com")).toEqual({ kind: "relative", path: "example.com" });
  });
});

describe("documentLinkTarget", () => {
  const baseUri = "manuscript://book-one/chapter-212.md";

  it("projects the three internal spellings onto the resolution port's union", () => {
    expect(documentLinkTarget({ kind: "wikilink", name: "Kael" }, baseUri)).toEqual({
      kind: "wikilink",
      name: "Kael",
    });
    expect(documentLinkTarget({ kind: "scheme", uri: "work://a/b.md" }, baseUri)).toEqual({
      kind: "scheme",
      uri: "work://a/b.md",
    });
    expect(documentLinkTarget({ kind: "relative", path: "../kael.md" }, baseUri)).toEqual({
      kind: "relative",
      path: "../kael.md",
      baseUri,
    });
  });

  it("never sends an external link to the server", () => {
    expect(
      documentLinkTarget({ kind: "external", url: "https://example.com" }, baseUri),
    ).toBeNull();
  });
});

describe("normalizeLinkHref", () => {
  it.each([
    ["example.com", "https://example.com"],
    [" example.com/path ", "https://example.com/path"],
    ["//example.com/path", "https://example.com/path"],
    ["http://example.com", "http://example.com"],
    ["https://example.com", "https://example.com"],
    ["mailto:writer@example.com", "mailto:writer@example.com"],
    ["[[The Second Gate]]", "[[The Second Gate]]"],
    ["  [[ Warden Ilsever ]]  ", "[[Warden Ilsever]]"],
    ["manuscript://appendix/vault-charter", "manuscript://appendix/vault-charter"],
    ["work://a1b2/notes.md", "work://a1b2/notes.md"],
    ["chapter-213.md", "chapter-213.md"],
    ["../notes/kael.md", "../notes/kael.md"],
    ["./sidebar.mdx", "./sidebar.mdx"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeLinkHref(input)).toBe(expected);
  });

  it.each([
    "",
    "   ",
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "ftp://example.com",
    "https://",
    "mailto:",
    "://example.com",
    "[[Kael|the warden]]",
  ])("rejects %s", (input) => {
    expect(normalizeLinkHref(input)).toBeNull();
  });

  it("round-trips through the classifier", () => {
    const href = normalizeLinkHref("chapter-213.md");
    expect(href).not.toBeNull();
    expect(classifyLinkTarget(href ?? "")).toEqual({ kind: "relative", path: "chapter-213.md" });
  });
});

describe("control characters", () => {
  // Browsers strip tab, LF, and CR out of a URL before resolving it; a parser
  // that only looks at the outside of the string does not. That gap is the
  // whole smuggling trick, and an AI or a collab peer writes marks straight
  // into the document without ever passing a form.
  it.each([
    "java\tscript:globalThis.owned=1",
    "java\nscript:alert(1)",
    "java\rscript:alert(1)",
    "javascript:alert(1)",
    "data\t:text/html,unsafe",
    "https://exam\tple.com",
    "\u0001javascript:alert(1)",
  ])("refuses %j", (href) => {
    expect(classifyLinkTarget(href)).toBeNull();
    expect(normalizeLinkHref(href)).toBeNull();
  });

  it("still accepts a target the writer merely padded", () => {
    expect(classifyLinkTarget("\t https://example.com \n")).toEqual({
      kind: "external",
      url: "https://example.com/",
    });
  });
});

describe("linkTargetHref", () => {
  it("is what a link renders, so the DOM never carries an href nobody classified", () => {
    expect(linkTargetHref({ kind: "wikilink", name: "The Second Gate" })).toBe(
      "[[The Second Gate]]",
    );
    expect(linkTargetHref({ kind: "scheme", uri: "manuscript://a.md" })).toBe("manuscript://a.md");
    expect(linkTargetHref({ kind: "relative", path: "../a.md" })).toBe("../a.md");
    expect(linkTargetHref({ kind: "external", url: "https://example.com/" })).toBe(
      "https://example.com/",
    );
  });

  it("hands back the URL parser's own reading of an external target", () => {
    // What the classifier validated and what the browser resolves have to be
    // the same string, or the fence guards a URL nobody navigates to.
    expect(classifyLinkTarget("https:\\\\example.com\\path")).toEqual({
      kind: "external",
      url: "https://example.com/path",
    });
  });
});
