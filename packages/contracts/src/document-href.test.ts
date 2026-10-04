/** Stored link spelling and resolution must name the same document. */
import { expect, it } from "vitest";
import {
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
  ["scratch://@/notes/base.md", "scratch://@/Gate.md", "../Gate.md"],
  ["manuscript://base.md", "kb://Gate.md", "kb://Gate.md"],
  ["scratch://@first/base.md", "scratch://@second/Gate.md", "scratch://@second/Gate.md"],
  [null, "scratch://@/Lin Feng.md", "scratch://@/Lin Feng.md"],
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

// Each row is a spelling rule, with the destination's current location.
it.each([
  ["rename", "chapter-1.md", "manuscript://v/base.md", "manuscript://v/the-gate.md", "the-gate.md"],
  [
    "incoming folder move",
    "old/chapter.md",
    "manuscript://base.md",
    "manuscript://new/chapter.md",
    "new/chapter.md",
  ],
  [
    "outgoing from moved holder",
    "../cast.md",
    "manuscript://v/scenes/base.md",
    "manuscript://cast.md",
    "../../cast.md",
  ],
  [
    "two descendants moved",
    "next.md",
    "manuscript://new/base.md",
    "manuscript://new/next.md",
    "next.md",
  ],
  [
    "two moved encoded descendants",
    "next%20chapter.md#s",
    "manuscript://new/base.md",
    "manuscript://new/next chapter.md",
    "next%20chapter.md#s",
  ],
  [
    "full between descendants",
    "manuscript://old/next.md",
    "manuscript://new/base.md",
    "manuscript://new/next.md",
    "manuscript://new/next.md",
  ],
  [
    "folder depth unchanged",
    "../cast.md",
    "manuscript://new/base.md",
    "manuscript://cast.md",
    "../cast.md",
  ],
  [
    "self link",
    "./chapter-1.md",
    "manuscript://the-gate.md",
    "manuscript://the-gate.md",
    "./the-gate.md",
  ],
  ["cross scheme", "chapter.md", "manuscript://base.md", "kb://chapter.md", "kb://chapter.md"],
  [
    "cross Work",
    "chapter.md",
    "scratch://@first/base.md",
    "scratch://@second/chapter.md",
    "scratch://@second/chapter.md",
  ],
  [
    "explicit Work stays explicit",
    "scratch://@first/chapter.md",
    "scratch://@second/base.md",
    "scratch://@second/gate.md",
    "scratch://@second/gate.md",
  ],
  [
    "explicit No Work",
    "scratch://@/chapter.md",
    null,
    "scratch://@second/gate.md",
    "scratch://@second/gate.md",
  ],
  [
    "authority drops in project area",
    "scratch://@first/chapter.md",
    null,
    "manuscript://gate.md",
    "manuscript://gate.md",
  ],
  [
    "full stays full in same area",
    "kb://chapter.md",
    "kb://base.md",
    "kb://gate.md",
    "kb://gate.md",
  ],
  ["extension omitted", "chapter", "manuscript://base.md", "manuscript://gate.md", "gate"],
  ["non prose extension omitted", "outline", "kb://base.md", "kb://plan.json", "plan"],
  ["omission across areas", "chapter", "manuscript://base.md", "kb://gate.md", "kb://gate"],
  [
    "fragment",
    "chapter.md#scene?view=outline",
    "manuscript://base.md",
    "manuscript://gate.md",
    "gate.md#scene?view=outline",
  ],
  [
    "query",
    "chapter?view=outline#scene",
    "manuscript://base.md",
    "manuscript://gate.md",
    "gate?view=outline#scene",
  ],
  [
    "escaped syntax",
    "old%23draft%3F%25.md#keep%20this",
    "kb://base.md",
    "kb://100% ready#final?.md",
    "100%25 ready%23final%3F.md#keep%20this",
  ],
  ["encoded space", "old%20name.md", "kb://base.md", "kb://new name.md", "new name.md"],
  [
    "dangling intended address",
    "../../unwritten.md",
    "manuscript://base.md",
    "manuscript://unwritten.md",
    "unwritten.md",
  ],
  ["already new address", "gate.md", "kb://base.md", "kb://gate.md", "gate.md"],
])("respells %s", (_rule, href, holderUri, targetUri, expected) => {
  expect(respellDocumentHref(href, { holderUri, targetUri })).toBe(expected);
  const resolved = resolveDocumentHref(expected, holderUri);
  expect(resolved).not.toBeNull();
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
