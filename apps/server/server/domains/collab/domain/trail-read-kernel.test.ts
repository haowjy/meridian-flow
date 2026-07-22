/** Behavioral coverage for the pure change-trail read kernel. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  bodyFromHashline,
  deletionBoundaryTarget,
  liveBlockTarget,
  navigationForSweptBlock,
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
    beforeBlockId: "block-a",
    afterBlockId: "block-a",
    beforeBlockIdentity: { documentId: "doc-a", clientID: 1, clock: 1 },
    afterBlockIdentity: { documentId: "doc-a", clientID: 1, clock: 1 },
    beforeText: "before",
    afterTextAtReceipt: "after",
    navigation: { kind: "unavailable", reason: "capture_failed" },
    swept: null,
    owner: { threadId: "thread-a", turnId: "turn-a" },
    sequence: 1,
    ...overrides,
  };
}

describe("trail navigation", () => {
  it("anchors a full-document delete at the durable empty root", () => {
    const { doc } = docWithBlocks();
    expect(deletionBoundaryTarget({ doc })).toMatchObject({
      kind: "deletion_boundary",
      affinity: "document_start",
    });
  });

  it("does not guess a replacement when operation correspondence is ambiguous", () => {
    const { doc, blocks } = docWithBlocks("new-a", "new-b");
    const result = navigationForSweptBlock({
      affectedBlockHash: "old",
      afterDoc: doc,
      operations: [
        {
          removedBlockHashes: ["old"],
          insertedBlocks: [
            { blockId: "new-a", block: blocks[0] },
            { blockId: "new-b", block: blocks[1] },
          ],
        },
      ],
    });
    expect(result).toEqual({
      outcome: "delete",
      navigation: { kind: "unavailable", reason: "capture_failed" },
    });
  });

  it("rejects a modify target after its block is deleted even if anchors resolve", () => {
    const { doc, blocks } = docWithBlocks("target", "neighbor");
    const target = liveBlockTarget(doc, blocks[0]);
    doc.getXmlFragment("prosemirror").delete(0, 1);
    expect(validateLiveBlockTarget({ doc, target })).toBe(false);
  });

  it("proves exactly one replacement and validates its surviving identity", () => {
    const { doc, blocks } = docWithBlocks("replacement");
    const result = navigationForSweptBlock({
      affectedBlockHash: "old",
      afterDoc: doc,
      operations: [
        {
          removedBlockHashes: ["old"],
          insertedBlocks: [{ blockId: "replacement", block: blocks[0] }],
        },
      ],
    });
    expect(result.outcome).toBe("modify");
    expect(validateLiveBlockTarget({ doc, target: result.navigation })).toBe(true);
  });

  it("captures only the body suffix of a protocol hashline", () => {
    expect(bodyFromHashline("hash|Writer markdown")).toEqual({
      status: "available",
      markdown: "Writer markdown",
    });
  });
});

describe("trail normalization", () => {
  it("folds repeated block changes and removes a net-cancelled change", () => {
    const trails = normalizeTrailPushes([
      {
        pushId: "p1",
        receiptId: "r1",
        threadId: "thread-a",
        journalOwners: [{ threadId: "thread-a", turnId: "turn-a" }],
        changes: [
          change(),
          change({ changeId: "c2", beforeText: "after", afterTextAtReceipt: "final", sequence: 2 }),
        ],
      },
    ]);
    expect(trails[0].changes).toHaveLength(1);
    expect(trails[0].changes[0]).toMatchObject({
      beforeText: "before",
      afterTextAtReceipt: "final",
    });

    const cancelled = normalizeTrailPushes([
      {
        pushId: "p1",
        receiptId: "r1",
        threadId: "thread-a",
        journalOwners: [],
        changes: [
          change({ kind: "insert", beforeText: null }),
          change({ kind: "delete", beforeText: "after", afterTextAtReceipt: null, sequence: 2 }),
        ],
      },
    ]);
    expect(cancelled[0].changes).toEqual([]);
  });

  it("folds one canonical block when a display-hash prefix widens", () => {
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
            beforeBlockId: "abcd",
            afterBlockId: "abcd",
            beforeBlockIdentity: identity,
            afterBlockIdentity: identity,
          }),
          change({
            changeId: "must-not-split",
            beforeBlockId: "abcdef",
            afterBlockId: "abcdef",
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

  it("preserves stable push grouping and ordering across documents", () => {
    const trails = normalizeTrailPushes([
      {
        pushId: "p1",
        receiptId: "r1",
        threadId: "thread-a",
        journalOwners: [],
        changes: [change()],
      },
      {
        pushId: "p2",
        receiptId: "r2",
        threadId: "thread-a",
        journalOwners: [],
        changes: [
          change({
            changeId: "c2",
            documentId: "doc-b",
            beforeBlockId: "block-b",
            afterBlockId: "block-b",
            beforeBlockIdentity: { documentId: "doc-b", clientID: 2, clock: 1 },
            afterBlockIdentity: { documentId: "doc-b", clientID: 2, clock: 1 },
            sequence: 2,
            pushId: "p2",
            receiptId: "r2",
          }),
        ],
      },
    ]);
    expect(
      trails[0].changes.map(({ pushId, receiptId, ordinal }) => ({ pushId, receiptId, ordinal })),
    ).toEqual([
      { pushId: "push-a", receiptId: "receipt-a", ordinal: 0 },
      { pushId: "p2", receiptId: "r2", ordinal: 1 },
    ]);
    expect(trails[0].counts).toEqual({ changes: 2, swept: 0, documents: 2 });
  });

  it("classifies an unattributable swept effect as shared", () => {
    const swept = change({
      swept: {
        affectedBlockHash: "hash",
        removed: { status: "available", markdown: "lost" },
        beforeContentRef: 1,
      },
    });
    const trails = normalizeTrailPushes([
      {
        pushId: "p1",
        receiptId: "r1",
        threadId: "thread-a",
        journalOwners: [
          { threadId: "thread-a", turnId: "turn-a" },
          { threadId: "thread-a", turnId: "turn-b" },
        ],
        changes: [swept],
      },
    ]);
    expect(trails).toHaveLength(1);
    expect(trails[0].owner).toEqual({ kind: "shared", threadId: "thread-a", turnId: null });
    expect(trails[0].counts.swept).toBe(1);
  });

  it("omits an ordinary generative addition", () => {
    const trails = normalizeTrailPushes([
      {
        pushId: "p1",
        receiptId: "r1",
        threadId: "thread-a",
        journalOwners: [],
        changes: [change({ kind: "insert", beforeText: null })],
      },
    ]);
    expect(trails[0].counts).toEqual({ changes: 0, swept: 0, documents: 0 });
    expect(trails[0].changes).toEqual([]);
  });
});
