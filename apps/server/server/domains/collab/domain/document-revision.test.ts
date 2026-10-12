/** Snapshot identity includes tombstones and formatting, not just insertion clocks. */

import { createStaticDocumentLinks } from "@meridian/agent-edit/integration";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { documentRevision as revisionIn } from "./document-revision.js";

const scope = createStaticDocumentLinks().scopeFor("chapter", undefined);
const documentRevision = (doc: Y.Doc) => revisionIn(doc, scope);

describe("documentRevision", () => {
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
