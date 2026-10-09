/** Behavioral coverage for the pure change-trail read kernel. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  liveBlockTarget,
  normalizeTrailPushes,
  type RawTrailChange,
  validateLiveBlockTarget,
} from "./trail-read-kernel.js";

function docWithBlocks(...ids: string[]): { doc: Y.Doc; blocks: Y.XmlElement[] } {
  const doc = new Y.Doc({ gc: false });
  const root = doc.getXmlFragment("prosemirror");
  const blocks = ids.map((id) => {
    const block = new Y.XmlElement("paragraph");
    block.setAttribute("block-id", id);
    block.insert(0, [new Y.XmlText(id)]);
    return block;
  });
  root.insert(0, blocks);
  return { doc, blocks };
}

function change(overrides: Partial<RawTrailChange> = {}): RawTrailChange {
  return {
    changeId: "c1",
    documentId: "doc-a",
    pushId: "push-a",
    receiptId: "receipt-a",
    kind: "modify",
    beforeBlockIdentity: { documentId: "doc-a", clientID: 1, clock: 1 },
    afterBlockIdentity: { documentId: "doc-a", clientID: 1, clock: 1 },
    beforeText: "before",
    afterTextAtReceipt: "after",
    navigation: { kind: "unavailable", reason: "capture_failed" },
    owner: { threadId: "thread-a", turnId: "turn-a" },
    sequence: 1,
    ...overrides,
  };
}

describe("trail navigation", () => {
  it("rejects a modify target after its block is deleted even if anchors resolve", () => {
    const { doc, blocks } = docWithBlocks("target", "neighbor");
    const target = liveBlockTarget(doc, blocks[0]);
    doc.getXmlFragment("prosemirror").delete(0, 1);
    expect(validateLiveBlockTarget({ doc, target })).toBe(false);
  });
});

describe("trail normalization", () => {
  it("folds repeated changes with the same canonical block identity", () => {
    const identity = { documentId: "doc-a", clientID: 42, clock: 7 };
    const trails = normalizeTrailPushes([
      {
        pushId: "p1",
        receiptId: "r1",
        threadId: "thread-a",
        journalOwners: [{ threadId: "thread-a", turnId: "turn-a" }],
        changes: [
          change({
            changeId: "canonical-change",
            beforeBlockIdentity: identity,
            afterBlockIdentity: identity,
          }),
          change({
            changeId: "must-not-split",
            beforeBlockIdentity: identity,
            afterBlockIdentity: identity,
            beforeText: "after",
            afterTextAtReceipt: "final",
            sequence: 2,
          }),
        ],
      },
    ]);

    expect(trails[0].changes).toHaveLength(1);
    expect(trails[0].changes[0]).toMatchObject({
      changeId: "canonical-change",
      beforeText: "before",
      afterTextAtReceipt: "final",
    });
  });
});
