/** Contract tests for resolving and spelling internal document destinations. */

import { describe, expect, it } from "vitest";
import { resolveDocumentHref, spellDocumentHref } from "./document-href.js";

describe("resolveDocumentHref", () => {
  it.each([
    ["chapter-2.md", "manuscript://volume-1/chapter-1.md", "manuscript://volume-1/chapter-2.md"],
    [
      "scenes/opening.md",
      "manuscript://volume-1/chapter-1.md",
      "manuscript://volume-1/scenes/opening.md",
    ],
    [
      "../volume-2/chapter-1.md",
      "manuscript://volume-1/chapter-1.md",
      "manuscript://volume-2/chapter-1.md",
    ],
    ["../Gate.md", "scratch://@revision/notes/plan.md", "scratch://@revision/Gate.md"],
    ["../Gate.md", "scratch://@/notes/plan.md", "scratch://@/Gate.md"],
  ])("resolves %s from %s", (href, baseUri, uri) => {
    expect(resolveDocumentHref(href, baseUri)).toEqual({ uri, suffix: "" });
  });

  it("canonicalizes full Context URIs while preserving their written authority", () => {
    expect(resolveDocumentHref("scratch:////@revision//notes/./plan.md", null)).toEqual({
      uri: "scratch://@revision/notes/plan.md",
      suffix: "",
    });
    expect(resolveDocumentHref("scratch://@/notes/plan.md", null)?.uri).toBe(
      "scratch://@/notes/plan.md",
    );
  });

  it.each([
    ["chapter.md#scene-2", "chapter.md", "#scene-2"],
    ["chapter.md?view=outline#scene-2", "chapter.md", "?view=outline#scene-2"],
    ["chapter.md#scene-2?view=outline", "chapter.md", "#scene-2?view=outline"],
  ])("keeps the suffix in %s", (href, path, suffix) => {
    expect(resolveDocumentHref(href, "manuscript://volume/base.md")).toEqual({
      uri: `manuscript://volume/${path}`,
      suffix,
    });
  });

  it("decodes path segments without treating encoded suffix characters as syntax", () => {
    expect(
      resolveDocumentHref("chapter%20one%23draft%3F.md#scene", "manuscript://base.md"),
    ).toEqual({
      uri: "manuscript://chapter one#draft?.md",
      suffix: "#scene",
    });
    expect(resolveDocumentHref("kb://cast/Lin%20Feng.md", null)?.uri).toBe("kb://cast/Lin Feng.md");
  });

  it.each([
    ["", "manuscript://base.md"],
    ["#fragment", "manuscript://base.md"],
    ["/chapter.md", "manuscript://base.md"],
    ["chapter/", "manuscript://base.md"],
    ["https://example.com/chapter.md", "manuscript://base.md"],
    ["mailto:writer@example.com", "manuscript://base.md"],
    ["chapter.md", null],
    ["../../chapter.md", "manuscript://volume/base.md"],
    ["bad%escape.md", "manuscript://base.md"],
    ["chapter%2Fscene.md", "manuscript://base.md"],
    ["manuscript://", null],
    ["manuscript://volume/", null],
  ])("rejects invalid document destination %s", (href, baseUri) => {
    expect(resolveDocumentHref(href, baseUri)).toBeNull();
  });
});

describe("spellDocumentHref", () => {
  it.each([
    ["manuscript://volume-1/chapter-1.md", "manuscript://volume-1/chapter-2.md", "chapter-2.md"],
    [
      "manuscript://volume-1/chapter-1.md",
      "manuscript://volume-1/scenes/opening.md",
      "scenes/opening.md",
    ],
    [
      "manuscript://volume-2/chapter-1.md",
      "manuscript://volume-1/chapter-1.md",
      "../volume-1/chapter-1.md",
    ],
    [
      "manuscript://volume-2/scenes/a.md",
      "manuscript://volume-1/chapter-1.md",
      "../../volume-1/chapter-1.md",
    ],
    ["scratch://@revision/notes/a.md", "scratch://@revision/Gate.md", "../Gate.md"],
    ["scratch://@/notes/a.md", "scratch://@/Gate.md", "../Gate.md"],
  ])("spells %s → %s as %s", (holder, target, href) => {
    expect(spellDocumentHref(holder, target)).toBe(href);
    expect(resolveDocumentHref(href, holder)?.uri).toBe(target);
  });

  it("never consumes the target's filename as a shared folder", () => {
    expect(spellDocumentHref("manuscript://x/notes.md", "manuscript://x")).toBe("../x");
    expect(resolveDocumentHref("../x", "manuscript://x/notes.md")?.uri).toBe("manuscript://x");
    expect(spellDocumentHref("manuscript://x/y/notes.md", "manuscript://x/y")).toBe("../y");
    expect(resolveDocumentHref("../y", "manuscript://x/y/notes.md")?.uri).toBe("manuscript://x/y");
  });

  it.each([
    ["manuscript://chapter.md", "kb://chapter.md", "kb://chapter.md"],
    ["scratch://@first/a.md", "scratch://@second/a.md", "scratch://@second/a.md"],
    [null, "scratch://@/notes.md", "scratch://@/notes.md"],
  ])("uses a full URI across areas", (holder, target, href) => {
    expect(spellDocumentHref(holder, target)).toBe(href);
    expect(resolveDocumentHref(href, holder)?.uri).toBe(target);
  });

  it("leaves spaces readable and encodes only percent and suffix delimiters", () => {
    const target = "manuscript://volume 1/100% ready#final?.md";
    const href = spellDocumentHref("manuscript://other/base.md", target);
    expect(href).toBe("../volume 1/100%25 ready%23final%3F.md");
    expect(resolveDocumentHref(href, "manuscript://other/base.md")?.uri).toBe(target);
  });

  it("rejects a target that is not a document Context URI", () => {
    expect(() => spellDocumentHref(null, "https://example.com/a.md")).toThrow(RangeError);
    expect(() => spellDocumentHref(null, "manuscript://")).toThrow(RangeError);
  });
});
