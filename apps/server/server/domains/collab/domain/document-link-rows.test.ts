/** Link-index keys for every stored occurrence kind (contract §11, L5). */
import { expect, it } from "vitest";
import { deriveDocumentLinkRows } from "./document-link-rows.js";

const DOC = "00000000-0000-4000-8000-0000000000d1";
const AHEAD = "00000000-0000-4000-8000-0000000000a1";
const ASSET = "00000000-0000-4000-8000-0000000000f1";

it("keys doc, ahead, asset and contextual occurrences, counting repeats once per key", () => {
  expect(
    deriveDocumentLinkRows({
      holderUri: "kb://base.md",
      occurrences: [
        { kind: "link", ref: `doc:${DOC}`, href: "manuscript://ch%201.md#top" },
        { kind: "link", ref: `doc:${DOC}`, href: "manuscript://ch%201.md" },
        { kind: "link", ref: `ahead:${AHEAD}`, href: "scratch://@arc/next.md" },
        { kind: "image", ref: `ahead:${AHEAD}`, href: "scratch://@arc/next.md" },
        { kind: "image", ref: null, href: `asset:${ASSET}` },
        { kind: "figure", ref: null, href: `asset:${ASSET}` },
        { kind: "link", ref: null, href: "scratch://notes.md" },
      ],
    }),
  ).toEqual([
    {
      linkKey: `doc:${DOC}`,
      targetDocumentId: DOC,
      aheadId: null,
      address: "manuscript://ch 1.md",
      occurrences: 2,
    },
    {
      linkKey: `ahead:${AHEAD}`,
      targetDocumentId: null,
      aheadId: AHEAD,
      address: "scratch://@arc/next.md",
      occurrences: 2,
    },
    {
      linkKey: `asset:${ASSET}`,
      targetDocumentId: ASSET,
      aheadId: null,
      address: null,
      occurrences: 2,
    },
    {
      linkKey: "scratch://notes.md",
      targetDocumentId: null,
      aheadId: null,
      address: null,
      occurrences: 1,
    },
  ]);
});

it("skips external hrefs, malformed refs and ref-less internal hrefs", () => {
  expect(
    deriveDocumentLinkRows({
      holderUri: "manuscript://base.md",
      occurrences: [
        { kind: "link", ref: null, href: "https://example.com" },
        { kind: "link", ref: "doc:not-a-uuid", href: "manuscript://next.md" },
        { kind: "link", ref: `ahead:${AHEAD}`, href: "https://example.com" },
        { kind: "link", ref: null, href: "next.md" },
        { kind: "image", ref: null, href: "asset:not-a-uuid" },
        { kind: "link", ref: null, href: "%ZZ" },
      ],
    }),
  ).toEqual([]);
});
