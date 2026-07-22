/** Regression coverage for the persisted trail reducer across successive pushes. */
import { describe, expect, it } from "vitest";
import type { TrailChangeV1 } from "../domain/trail-read-kernel.js";
import { mergeTrailChanges } from "./drizzle-change-trails.js";

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
    swept: null,
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
