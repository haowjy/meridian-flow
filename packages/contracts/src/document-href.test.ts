/** Stored link spelling and resolution must name the same document. */
import { describe, expect, it } from "vitest";
import {
  documentAddressKey,
  documentPathKey,
  matchDocumentPath,
  resolveDocumentHref,
  respellDocumentHref,
  spellDocumentHref,
} from "./document-href.js";

it.each([
  ["manuscript://v/base.md", "manuscript://v/next.md", "next.md"],
  ["manuscript://v/base.md", "manuscript://v/scenes/open.md", "scenes/open.md"],
  ["manuscript://v/scenes/base.md", "manuscript://other/next.md", "../../other/next.md"],
  ["manuscript://x/base.md", "manuscript://x", "../x"],
  ["scratch://@revision/notes/base.md", "scratch://@revision/Gate.md", "../Gate.md"],
  ["scratch://@/c12/notes/base.md", "scratch://@/c12/Gate.md", "../Gate.md"],
  ["manuscript://base.md", "kb://Gate.md", "kb://Gate.md"],
  ["scratch://@first/base.md", "scratch://@second/Gate.md", "scratch://@second/Gate.md"],
  [null, "scratch://@/c12/Lin Feng.md", "scratch://@/c12/Lin Feng.md"],
  [
    "manuscript://other/base.md",
    "manuscript://volume 1/100% ready#final?.md",
    "../volume 1/100%25 ready%23final%3F.md",
  ],
  [null, "scratch://@revision/100%#?.md", "scratch://@revision/100%25%23%3F.md"],
])("round-trips %s → %s as %s", (holder, target, href) => {
  expect(spellDocumentHref(holder, target)).toBe(href);
  expect(resolveDocumentHref(href, holder)).toEqual({ uri: target, suffix: "" });
});

it.each([
  ["scratch:////@revision//notes/./plan.md", "scratch://@revision/notes/plan.md", ""],
  ["Kb://cast/Lin%20Feng.md#bio", "kb://cast/Lin Feng.md", "#bio"],
  [
    "chapter%23draft%3F.md?view=outline#scene",
    "manuscript://v/chapter#draft?.md",
    "?view=outline#scene",
  ],
  ["chapter.md#scene?view=outline", "manuscript://v/chapter.md", "#scene?view=outline"],
  ["foo/bar://x.md", "manuscript://v/foo/bar:/x.md", ""],
])("resolves %s without mistaking authority or encoded path for syntax", (href, uri, suffix) => {
  expect(resolveDocumentHref(href, "manuscript://v/base.md")).toEqual({ uri, suffix });
});

it.each([
  ["", "manuscript://base.md"],
  ["#fragment", "manuscript://base.md"],
  ["/chapter.md", "manuscript://base.md"],
  ["chapter/", "manuscript://base.md"],
  ["https://example.com/chapter.md", "manuscript://base.md"],
  ["mailto:writer@example.com", "manuscript://base.md"],
  ["chapter.md", null],
  ["../../chapter.md", "manuscript://v/base.md"],
  ["bad%escape.md", "manuscript://base.md"],
  ["chapter%2Fscene.md", "manuscript://base.md"],
  ["manuscript://", null],
  ["manuscript://volume/", null],
])("rejects invalid document destination %s", (href, holder) => {
  expect(resolveDocumentHref(href, holder)).toBeNull();
});

it.each(["https://example.com/a.md", "manuscript://"])("never spells non-document %s", (target) => {
  expect(() => spellDocumentHref(null, target)).toThrow(RangeError);
});

// One row per stored-spelling rule, not per move scenario.
it.each([
  ["chapter.md", "manuscript://v/base.md", "manuscript://new/gate.md", "../new/gate.md"],
  ["next%20name.md#s", "kb://base.md", "kb://next name.md", "next%20name.md#s"],
  ["kb://old.md", "kb://base.md", "kb://gate.md", "kb://gate.md"],
  ["./old.md", "kb://gate.md", "kb://gate.md", "./gate.md"],
  ["old.md", "manuscript://base.md", "kb://gate.md", "kb://gate.md"],
  ["old.md", "scratch://@first/base.md", "scratch://@second/gate.md", "scratch://@second/gate.md"],
  ["old", "kb://base.md", "kb://plan.json", "plan"],
  ["old", "manuscript://base.md", "kb://gate.md", "kb://gate"],
  ["old?view=outline#scene", "kb://base.md", "kb://gate.md", "gate?view=outline#scene"],
  ["old%23.md#s", "kb://base.md", "kb://100%#?.md", "100%25%23%3F.md#s"],
  ["../../unwritten.md", "manuscript://base.md", "manuscript://unwritten.md", "unwritten.md"],
])("respells %s from %s to %s as %s", (href, holderUri, targetUri, expected) => {
  expect(respellDocumentHref(href, { holderUri, targetUri })).toBe(expected);
});

it.each([
  ["chapter.md", ["chapter.md", "chapter.json"], "chapter.md"],
  ["chapter", ["chapter.md"], "chapter.md"],
  ["chapter", ["chapter", "chapter.md"], "chapter"],
  ["chapter", ["chapter.md", "chapter.json"], null],
  ["Chapter.md", ["chapter.md"], null],
  ["v/chapter", ["chapter.md"], null],
])("matches the catalog path %s", (path, candidates, expected) => {
  expect(documentPathKey(path)).toBe(path);
  expect(matchDocumentPath(candidates, path, (candidate) => candidate)).toBe(expected);
});

it.each([
  ["manuscript:////v/./chapter.md", "manuscript://v/chapter.md"],
  ["scratch://@arc/notes/chapter.md", "scratch://@arc/notes/chapter.md"],
  ["uploads://@/image.png", "uploads://@/image.png"],
  ["user://preferences.md", "user://preferences.md"],
])("keys explicit address %s as %s", (uri, key) => {
  expect(documentAddressKey(uri)).toBe(key);
});
it.each([
  "scratch://chapter.md",
  "uploads://image.png",
  "https://example.com",
  "manuscript://",
])("rejects non-address key %s", (uri) => {
  expect(() => documentAddressKey(uri)).toThrow(RangeError);
});

describe("lineage Scratch owner boundaries", () => {
  it("resolves within a lineage and refuses traversal beyond its root", () => {
    expect(resolveDocumentHref("../plan.md", "scratch://@/c12/notes/one.md")?.uri).toBe(
      "scratch://@/c12/plan.md",
    );
    expect(resolveDocumentHref("../c40/plan.md", "scratch://@/c12/one.md")).toBeNull();
    expect(resolveDocumentHref("scratch://@/plan.md", null)).toBeNull();
    expect(resolveDocumentHref("scratch://@other/@/c12/plan.md", null)).toBeNull();
  });
  it("spells same-lineage links relatively, but cross-lineage and move-out links fully", () => {
    expect(spellDocumentHref("scratch://@/c12/one.md", "scratch://@/c12/two.md")).toBe("two.md");
    expect(spellDocumentHref("scratch://@/c12/one.md", "scratch://@/c40/two.md")).toBe(
      "scratch://@/c40/two.md",
    );
    expect(
      respellDocumentHref("./two.md", {
        holderUri: "manuscript://one.md",
        targetUri: "scratch://@/c12/two.md",
      }),
    ).toBe("scratch://@/c12/two.md");
    expect(documentAddressKey("scratch://@/c12/two.md")).not.toBe(
      documentAddressKey("scratch://@/c40/two.md"),
    );
  });
});
