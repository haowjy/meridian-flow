import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  buildEditedHunkUpdate,
  buildPartialUpdate,
} from "@/core/cm6-collab/review/partial-apply";
import type { ReviewHunk } from "@/core/cm6-collab/review/types";

function createDoc(content: string): Y.Doc {
  const doc = new Y.Doc();
  doc.getText("content").insert(0, content);
  return doc;
}

function hunk(overrides: Partial<ReviewHunk> = {}): ReviewHunk {
  return {
    id: "proposal-1-chunk-0",
    proposalId: "proposal-1",
    baseStart: 6,
    baseEnd: 11,
    deletedText: "world",
    insertedText: "earth",
    status: "pending",
    ...overrides,
  };
}

function textAfterUpdate(baseDoc: Y.Doc, update: Uint8Array): string {
  const nextDoc = new Y.Doc();
  Y.applyUpdate(nextDoc, Y.encodeStateAsUpdate(baseDoc));
  Y.applyUpdate(nextDoc, update);
  return nextDoc.getText("content").toString();
}

describe("buildPartialUpdate", () => {
  it("uses the hunk inserted text by default", () => {
    const base = createDoc("hello world");
    const update = buildPartialUpdate(base, hunk());

    expect(textAfterUpdate(base, update)).toBe("hello earth");
    expect(base.getText("content").toString()).toBe("hello world");
  });

  it("uses insertedTextOverride when provided", () => {
    const base = createDoc("hello world");
    const update = buildPartialUpdate(base, hunk(), "content", {
      insertedTextOverride: "planet",
    });

    expect(textAfterUpdate(base, update)).toBe("hello planet");
  });

  it("treats empty-string override as valid delete-only result", () => {
    const base = createDoc("hello world");
    const update = buildEditedHunkUpdate(base, hunk(), "");

    expect(textAfterUpdate(base, update)).toBe("hello ");
  });
});
