/** Consolidated test contracts; each block retains its original fixture scope. */

import { createStaticDocumentLinks } from "@meridian/agent-edit/integration";
import { describe as __mergedSuite, expect, it } from "vitest";
import * as Y from "yjs";
import { createDocumentContainment } from "./document-containment.js";
import { deriveDocumentLinkRows } from "./document-link-rows.js";
import { documentRevision as revisionIn } from "./document-revision.js";

__mergedSuite("document-containment.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/document-containment.test.ts.
  __mergedSuite("document containment", () => {
    it("invalidates its snapshot after a delete-only document mutation", () => {
      const document = new Y.Doc({ gc: false });
      document.getText("content").insert(0, "retained history");
      const client = new Y.Doc({ gc: false });
      Y.applyUpdate(client, Y.encodeStateAsUpdate(document));
      const beforeDelete = Y.encodeStateVector(client);
      client.getText("content").delete(0, 8);
      const deleteOnly = Y.encodeStateAsUpdate(client, beforeDelete);
      expect(Y.decodeUpdate(deleteOnly).structs).toHaveLength(0);
      const containment = createDocumentContainment();
      expect(containment.contains(document, deleteOnly)).toBe(false);
      Y.applyUpdate(document, deleteOnly);
      expect(containment.contains(document, deleteOnly)).toBe(true);
    });
    it("rejects struct novelty and exactly accepts contained updates", () => {
      const document = new Y.Doc({ gc: false });
      document.getText("content").insert(0, "current");
      const currentState = Y.encodeStateAsUpdate(document);
      const client = new Y.Doc({ gc: false });
      Y.applyUpdate(client, currentState);
      const beforeInsert = Y.encodeStateVector(client);
      client.getText("content").insert(7, " novel");
      const containment = createDocumentContainment();
      expect(containment.contains(document, currentState)).toBe(true);
      expect(containment.contains(document, Y.encodeStateAsUpdate(client, beforeInsert))).toBe(
        false,
      );
    });
  });
});

__mergedSuite("document-link-rows.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/document-link-rows.test.ts.
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
});

__mergedSuite("document-revision.test.ts", () => {
  // Merged from apps/server/server/domains/collab/domain/document-revision.test.ts.
  const scope = createStaticDocumentLinks().scopeFor("chapter", undefined);

  const documentRevision = (doc: Y.Doc) => revisionIn(doc, scope);

  __mergedSuite("documentRevision", () => {
    it("changes on insertion, pure deletion and formatting, but not a no-op", () => {
      const doc = new Y.Doc({ gc: false });
      const text = doc.getText("body");
      const empty = documentRevision(doc);
      expect(empty).toMatch(/^y2:[A-Za-z0-9_-]{43}$/);
      text.insert(0, "chapter");
      const inserted = documentRevision(doc);
      expect(inserted).not.toBe(empty);
      const vector = Y.encodeStateVector(doc);
      text.delete(0, 1);
      expect(Y.encodeStateVector(doc)).toEqual(vector);
      const deleted = documentRevision(doc);
      expect(deleted).not.toBe(inserted);
      text.format(0, 2, { bold: true });
      const formatted = documentRevision(doc);
      expect(formatted).not.toBe(deleted);
      doc.transact(() => {});
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(doc));
      expect(documentRevision(doc)).toBe(formatted);
      const copy = new Y.Doc({ gc: false });
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
      expect(documentRevision(copy)).toBe(formatted);
      copy.destroy();
      doc.destroy();
    });
  });
});
