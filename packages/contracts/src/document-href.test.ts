/** Stored link spelling and resolution must name the same document. */
import { expect, it } from "vitest";
import { resolveDocumentHref, spellDocumentHref } from "./document-href.js";

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
