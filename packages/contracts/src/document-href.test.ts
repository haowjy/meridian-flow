/** Stored link spelling and resolution must name the same document. */
import { expect, it } from "vitest";
import {
  documentPathKey,
  matchDocumentPath,
  resolveDocumentHref,
  spellDocumentHref,
} from "./document-href.js";

it.each([
  ["manuscript://v/scenes/base.md", "manuscript://other/next.md", "../../other/next.md"],
  ["manuscript://x/base.md", "manuscript://x", "../x"],
  ["scratch://@revision/notes/base.md", "scratch://@revision/Gate.md", "../Gate.md"],
  ["scratch://@first/base.md", "scratch://@second/Gate.md", "scratch://@second/Gate.md"],
  [
    "manuscript://other/base.md",
    "manuscript://volume 1/100% ready#final?.md",
    "../volume 1/100%25 ready%23final%3F.md",
  ],
])("round-trips %s → %s as %s", (holder, target, href) => {
  expect(spellDocumentHref(holder, target)).toBe(href);
  expect(resolveDocumentHref(href, holder)).toEqual({ uri: target, suffix: "" });
});

it.each([
  ["Kb://cast/Lin%20Feng.md#bio", "kb://cast/Lin Feng.md", "#bio"],
  [
    "chapter%23draft%3F.md?view=outline#scene",
    "manuscript://v/chapter#draft?.md",
    "?view=outline#scene",
  ],
  ["foo/bar://x.md", "manuscript://v/foo/bar:/x.md", ""],
])("resolves %s without mistaking authority or encoded path for syntax", (href, uri, suffix) => {
  expect(resolveDocumentHref(href, "manuscript://v/base.md")).toEqual({ uri, suffix });
});

it.each([
  ["", "manuscript://base.md"],
  ["/chapter.md", "manuscript://base.md"],
  ["chapter/", "manuscript://base.md"],
  ["https://example.com/chapter.md", "manuscript://base.md"],
  ["chapter.md", null],
  ["../../chapter.md", "manuscript://v/base.md"],
  ["bad%escape.md", "manuscript://base.md"],
  ["chapter%2Fscene.md", "manuscript://base.md"],
])("rejects invalid document destination %s", (href, holder) => {
  expect(resolveDocumentHref(href, holder)).toBeNull();
});

it.each(["manuscript://"])("never spells non-document %s", (target) => {
  expect(() => spellDocumentHref(null, target)).toThrow(RangeError);
});

it.each([
  ["chapter", ["chapter.md"], "chapter.md"],
  ["chapter", ["chapter", "chapter.md"], "chapter"],
  ["chapter", ["chapter.md", "chapter.json"], null],
  ["Chapter.md", ["chapter.md"], null],
])("matches the catalog path %s", (path, candidates, expected) => {
  expect(documentPathKey(path)).toBe(path);
  expect(matchDocumentPath(candidates, path, (candidate) => candidate)).toBe(expected);
});
