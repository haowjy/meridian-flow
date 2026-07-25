/** Regression coverage for the persisted trail reducer across successive pushes. */
import { describe, expect, it } from "vitest";
import type { TrailChangeV1 } from "../domain/trail-read-kernel.js";
import { mergeTrailChanges, refinePushChanges } from "./drizzle-change-trails.js";

function change(
  input: Partial<TrailChangeV1> &
    Pick<TrailChangeV1, "changeId" | "documentId" | "beforeText" | "afterTextAtReceipt">,
): TrailChangeV1 {
  return {
    ordinal: 0,
    pushId: null,
    receiptId: null,
    kind:
      input.beforeText === null
        ? "insert"
        : input.afterTextAtReceipt === null
          ? "delete"
          : "modify",
    beforeBlockId: input.beforeText === null ? null : input.changeId,
    afterBlockId: input.afterTextAtReceipt === null ? null : input.changeId,
    beforeBlockIdentity:
      input.beforeText === null
        ? null
        : {
            documentId: input.documentId as string,
            clientID: input.changeId.charCodeAt(0),
            clock: 0,
          },
    afterBlockIdentity:
      input.afterTextAtReceipt === null
        ? null
        : {
            documentId: input.documentId as string,
            clientID: input.changeId.charCodeAt(0),
            clock: 0,
          },
    navigation: { kind: "unavailable", reason: "capture_failed" },
    writerImpact: null,
    reversible: false,
    ...input,
  };
}

describe("mergeTrailChanges", () => {
  it("removes an insert cancelled by a later push delete", () => {
    const inserted = change({
      changeId: "x",
      documentId: "doc-a",
      beforeText: null,
      afterTextAtReceipt: "X",
    });
    const deleted = change({
      changeId: "x",
      documentId: "doc-a",
      beforeText: "X",
      afterTextAtReceipt: null,
    });
    expect(mergeTrailChanges(mergeTrailChanges([], [inserted]), [deleted])).toEqual([]);
  });

  it("removes A to B cancelled by a later push B to A", () => {
    const forward = change({
      changeId: "x",
      documentId: "doc-a",
      beforeText: "A",
      afterTextAtReceipt: "B",
    });
    const reverse = change({
      changeId: "x",
      documentId: "doc-a",
      beforeText: "B",
      afterTextAtReceipt: "A",
    });
    expect(mergeTrailChanges(mergeTrailChanges([], [forward]), [reverse])).toEqual([]);
  });

  it("keeps globally stable ordinals across documents and pushes", () => {
    const first = change({
      changeId: "a",
      documentId: "doc-a",
      beforeText: null,
      afterTextAtReceipt: "A",
    });
    const second = change({
      changeId: "b",
      documentId: "doc-b",
      beforeText: null,
      afterTextAtReceipt: "B",
    });
    expect(
      mergeTrailChanges(mergeTrailChanges([], [first]), [second]).map((item) => [
        item.documentId,
        item.ordinal,
      ]),
    ).toEqual([
      ["doc-a", 0],
      ["doc-b", 1],
    ]);
  });
});

describe("refinePushChanges", () => {
  it("preserves ordinary rows when completed sweep classification is empty", () => {
    const ordinary = change({
      changeId: "o",
      documentId: "doc-a",
      beforeText: "before|Captured ordinary body.",
      afterTextAtReceipt: null,
      pushId: "7",
    });

    expect(refinePushChanges([ordinary], [])).toEqual([ordinary]);
  });

  it("replaces classified detail, preserves impact presence, and creates no duplicates", () => {
    const rejected = change({
      changeId: "r",
      documentId: "doc-a",
      beforeText: "before-r|Observed body.",
      afterTextAtReceipt: null,
      pushId: "7",
      writerImpact: {
        kind: "sweep",
        affectedBlockHash: "before-r",
        body: { status: "available", markdown: "Observed body." },
        beforeContentRef: null,
      },
    });
    const provisional = change({
      changeId: "s",
      documentId: "doc-a",
      beforeText: "before-s|Unseen body.",
      afterTextAtReceipt: null,
      pushId: "7",
    });
    const classified = {
      ...provisional,
      writerImpact: {
        kind: "sweep" as const,
        affectedBlockHash: "before-s",
        body: { status: "available" as const, markdown: "Unseen body." },
        beforeContentRef: null,
      },
    };

    const refined = refinePushChanges([rejected, provisional], [classified]);
    expect(refined).toEqual([
      expect.objectContaining({ changeId: "r", writerImpact: rejected.writerImpact }),
      expect.objectContaining({ changeId: "s", writerImpact: classified.writerImpact }),
    ]);
  });
});
