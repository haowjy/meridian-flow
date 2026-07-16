/**
 * Model tests — pure hunk-decoding logic. No DOM, no editor. Anchors are
 * built here from real `Y.RelativePosition`s so the base64 round-trip is
 * exercised end-to-end.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  buildInlineReviewModel,
  decodeAnchor,
  hunkKind,
  indexOperations,
  type ResolvedBlockReviewHunk,
  type ResolvedReviewHunk,
  type ResolvedTextReviewHunk,
} from "./model";

function asText(hunk: ResolvedReviewHunk | undefined): ResolvedTextReviewHunk {
  if (hunk?.kind !== "text") throw new Error("expected text hunk");
  return hunk;
}

function asBlock(hunk: ResolvedReviewHunk | undefined): ResolvedBlockReviewHunk {
  if (hunk?.kind !== "block") throw new Error("expected block hunk");
  return hunk;
}

function encodeAnchor(position: Y.RelativePosition): string {
  const bytes = Y.encodeRelativePosition(position);
  return Buffer.from(bytes).toString("base64");
}

function spanLength(
  doc: Y.Doc,
  span: { from: Y.RelativePosition; to: Y.RelativePosition },
): number {
  const from = Y.createAbsolutePositionFromRelativePosition(span.from, doc);
  const to = Y.createAbsolutePositionFromRelativePosition(span.to, doc);
  if (!from || !to || from.type !== to.type) throw new Error("expected span in one text node");
  return to.index - from.index;
}

function makeAnchoredHunk(doc: Y.Doc, hunkId: string, opId: string): ReviewHunk {
  const fragment = doc.getXmlFragment("prosemirror");
  const relStart = Y.createRelativePositionFromTypeIndex(fragment, 0);
  const relEnd = Y.createRelativePositionFromTypeIndex(fragment, 0);
  return {
    hunkId,
    operationIds: [opId],
    anchor: {
      relStart: encodeAnchor(relStart),
      relEnd: encodeAnchor(relEnd),
    },
    kind: "text",
    spans: [],
  };
}

describe("decodeAnchor", () => {
  it("round-trips a valid base64-encoded RelativePosition", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("prosemirror");
    const relPos = Y.createRelativePositionFromTypeIndex(fragment, 0);
    const encoded = encodeAnchor(relPos);

    const decoded = decodeAnchor(encoded);
    expect(decoded).not.toBeNull();
    // Encoded byte payload should match if we re-encode.
    if (decoded) {
      expect(Buffer.from(Y.encodeRelativePosition(decoded)).toString("base64")).toBe(encoded);
    }
  });

  it("returns null for malformed input rather than throwing", () => {
    expect(decodeAnchor("!!!not-base64!!!")).toBeNull();
    expect(decodeAnchor("")).toBeNull();
  });

  it("accepts an item-scoped anchor (client + clock) — the common text-position case", () => {
    // The server encodes text-position anchors as RelativePositions whose only
    // addressability channel is `item: {client, clock}` — no `tname`, no
    // `type`. Rejecting these would drop every real hunk.
    const doc = new Y.Doc();
    doc.clientID = 42;
    const text = doc.getText("t");
    text.insert(0, "hello");
    const relPos = Y.createRelativePositionFromTypeIndex(text, 2);
    const encoded = encodeAnchor(relPos);
    const decoded = decodeAnchor(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.item?.client).toBe(42);
  });
});

describe("concurrent conflict mapping", () => {
  it("flags only hunks whose block hash conflicted", () => {
    const doc = new Y.Doc();
    const hunk = { ...makeAnchoredHunk(doc, "h1", "op-1"), blockHashes: ["block-a"] };
    const model = buildInlineReviewModel({
      draftRevisionToken: 1,
      operations: [],
      hunks: [hunk],
      conflictedBlocks: new Set(["block-a"]),
    });

    expect(model.hunks[0]).toMatchObject({ hunkId: "h1", concurrentConflict: true });
  });
});

describe("buildInlineReviewModel", () => {
  it("keeps hunks with resolvable anchors and drops the rest", () => {
    const doc = new Y.Doc();
    const good = makeAnchoredHunk(doc, "h1", "op-a");
    const broken: ReviewHunk = {
      hunkId: "h2",
      operationIds: ["op-a"],
      anchor: { relStart: "garbage", relEnd: "garbage" },
      kind: "text",
      spans: [],
    };

    const model = buildInlineReviewModel({
      draftRevisionToken: 7,
      operations: [
        {
          operationId: "op-a",
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "edited",
          classification: "rewrite",
          hunkCount: 2,
        },
      ],
      hunks: [good, broken],
    });

    expect(model.draftRevisionToken).toBe(7);
    expect(model.hunks).toHaveLength(1);
    expect(model.hunks[0].hunkId).toBe("h1");
    expect(model.operations).toHaveLength(1);
  });

  it("decodes span anchors into per-operation resolved spans", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("prosemirror");
    const text = new Y.XmlText();
    fragment.insert(0, [text]);
    text.insert(0, "hello");
    const anchorStart = Y.createRelativePositionFromTypeIndex(fragment, 0);
    const anchorMid = Y.createRelativePositionFromTypeIndex(fragment, 2);
    const anchorEnd = Y.createRelativePositionFromTypeIndex(fragment, 5);

    const model = buildInlineReviewModel({
      draftRevisionToken: 5,
      operations: [
        {
          operationId: "op-a",
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
        {
          operationId: "op-b",
          rejectSourceUpdateIds: [2],
          kind: "writer",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          hunkId: "h1",
          operationIds: ["op-a", "op-b"],
          anchor: {
            relStart: encodeAnchor(anchorStart),
            relEnd: encodeAnchor(anchorEnd),
          },
          kind: "text",
          spans: [
            {
              anchorFrom: encodeAnchor(anchorStart),
              anchorTo: encodeAnchor(anchorMid),
              operationId: "op-a",
            },
            {
              anchorFrom: encodeAnchor(anchorMid),
              anchorTo: encodeAnchor(anchorEnd),
              operationId: "op-b",
            },
          ],
        },
      ],
    });

    expect(model.hunks).toHaveLength(1);
    const resolved = asText(model.hunks[0]);
    expect(resolved.spans).toHaveLength(2);
    expect(resolved.spans.map((s) => s.operationId)).toEqual(["op-a", "op-b"]);
  });

  it("decodes marked inserted span anchors without losing visible characters", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("prosemirror");
    const text = new Y.XmlText();
    fragment.insert(0, [text]);
    text.insert(0, "The Odyssey sailed");
    const start = "The ".length;
    const insertedLength = "Odyssey".length;
    text.format(start, insertedLength, { em: true });
    const anchorStart = Y.createRelativePositionFromTypeIndex(text, start);
    const anchorEnd = Y.createRelativePositionFromTypeIndex(text, start + insertedLength);

    const model = buildInlineReviewModel({
      draftRevisionToken: 8,
      operations: [
        {
          operationId: "op-a",
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          hunkId: "h-marked",
          operationIds: ["op-a"],
          anchor: {
            relStart: encodeAnchor(anchorStart),
            relEnd: encodeAnchor(anchorEnd),
          },
          kind: "text",
          spans: [
            {
              anchorFrom: encodeAnchor(anchorStart),
              anchorTo: encodeAnchor(anchorEnd),
              operationId: "op-a",
            },
          ],
        },
      ],
    });

    const resolved = asText(model.hunks[0]);
    expect(resolved.spans).toHaveLength(1);
    expect(spanLength(doc, resolved.spans[0])).toBe(insertedLength);
  });

  it("drops span entries with malformed anchors but keeps the hunk", () => {
    const doc = new Y.Doc();
    const anchor = Y.createRelativePositionFromTypeIndex(doc.getXmlFragment("prosemirror"), 0);

    const model = buildInlineReviewModel({
      draftRevisionToken: 6,
      operations: [
        {
          operationId: "op-a",
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "added",
          classification: "addition",
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          hunkId: "h1",
          operationIds: ["op-a"],
          anchor: {
            relStart: encodeAnchor(anchor),
            relEnd: encodeAnchor(anchor),
          },
          kind: "text",
          spans: [{ anchorFrom: "garbage", anchorTo: encodeAnchor(anchor), operationId: "op-a" }],
        },
      ],
    });

    expect(model.hunks).toHaveLength(1);
    expect(asText(model.hunks[0]).spans).toHaveLength(0);
  });

  it("propagates deletedText onto resolved hunks", () => {
    const doc = new Y.Doc();
    const hunk = {
      ...makeAnchoredHunk(doc, "h1", "op-a"),
      deletedText: "removed prose",
    };
    const model = buildInlineReviewModel({
      draftRevisionToken: 1,
      operations: [
        {
          operationId: "op-a",
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "edited",
          classification: "rewrite",
          hunkCount: 1,
        },
      ],
      hunks: [hunk],
    });
    expect(asText(model.hunks[0]).deletedText).toBe("removed prose");
  });

  it("decodes a change block hunk and carries both display payloads", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("prosemirror");
    const element = new Y.XmlElement("horizontal_rule");
    fragment.insert(0, [element]);
    const relStart = Y.createRelativePositionFromTypeIndex(fragment, 0);
    const relEnd = Y.createRelativePositionFromTypeIndex(fragment, 1);

    const model = buildInlineReviewModel({
      draftRevisionToken: 11,
      operations: [
        {
          operationId: "op-a",
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "rewrote",
          classification: "rewrite",
          hunkCount: 1,
        },
      ],
      hunks: [
        {
          kind: "block",
          hunkId: "h1",
          operationIds: ["op-a"],
          anchor: { relStart: encodeAnchor(relStart), relEnd: encodeAnchor(relEnd) },
          insertedBlock: { type: "bullet_list", display: "new list item" },
          deletedBlock: { type: "bullet_list", display: "old list item" },
        },
      ],
    });

    expect(model.hunks).toHaveLength(1);
    const resolved = asBlock(model.hunks[0]);
    expect(resolved.insertedBlock).toEqual({ type: "bullet_list", display: "new list item" });
    expect(resolved.deletedBlock).toEqual({ type: "bullet_list", display: "old list item" });
  });

  it("decodes insert-only and delete-only block hunks", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("prosemirror");
    const element = new Y.XmlElement("horizontal_rule");
    fragment.insert(0, [element]);
    const relStart = Y.createRelativePositionFromTypeIndex(fragment, 0);
    const relEnd = Y.createRelativePositionFromTypeIndex(fragment, 1);

    const model = buildInlineReviewModel({
      draftRevisionToken: 12,
      operations: [],
      hunks: [
        {
          kind: "block",
          hunkId: "h-insert",
          operationIds: ["op-a"],
          anchor: { relStart: encodeAnchor(relStart), relEnd: encodeAnchor(relEnd) },
          insertedBlock: { type: "horizontal_rule", display: "───" },
        },
        {
          kind: "block",
          hunkId: "h-delete",
          operationIds: ["op-b"],
          anchor: { relStart: encodeAnchor(relStart), relEnd: encodeAnchor(relStart) },
          deletedBlock: { type: "horizontal_rule", display: "───" },
        },
      ],
    });

    expect(model.hunks).toHaveLength(2);
    const inserted = asBlock(model.hunks[0]);
    expect(inserted.insertedBlock?.display).toBe("───");
    expect(inserted.deletedBlock).toBeUndefined();
    const deleted = asBlock(model.hunks[1]);
    expect(deleted.deletedBlock?.type).toBe("horizontal_rule");
    expect(deleted.insertedBlock).toBeUndefined();
  });

  it("drops block hunks whose anchors will not decode", () => {
    const model = buildInlineReviewModel({
      draftRevisionToken: 13,
      operations: [],
      hunks: [
        {
          kind: "block",
          hunkId: "h1",
          operationIds: ["op-a"],
          anchor: { relStart: "garbage", relEnd: "garbage" },
          insertedBlock: { type: "horizontal_rule", display: "───" },
        },
      ],
    });
    expect(model.hunks).toHaveLength(0);
  });
});

describe("hunkKind", () => {
  function operation(id: string, kind: "agent" | "writer"): ReviewOperation {
    return {
      operationId: id,
      rejectSourceUpdateIds: [1],
      kind,
      contribution: "edited",
      classification: "rewrite",
      hunkCount: 1,
    };
  }

  it("returns writer when any contributing operation is writer-attributed", () => {
    const map = indexOperations([operation("op-a", "agent"), operation("op-b", "writer")]);
    const kind = hunkKind(
      {
        kind: "text",
        hunkId: "h1",
        operationIds: ["op-a", "op-b"],
        relStart: {} as never,
        relEnd: {} as never,
        spans: [],
      },
      map,
    );
    expect(kind).toBe("writer");
  });

  it("returns agent when every contributing operation is AI-attributed", () => {
    const map = indexOperations([operation("op-a", "agent")]);
    const kind = hunkKind(
      {
        kind: "text",
        hunkId: "h1",
        operationIds: ["op-a"],
        relStart: {} as never,
        relEnd: {} as never,
        spans: [],
      },
      map,
    );
    expect(kind).toBe("agent");
  });

  it("falls back to agent when no operation is known (best-effort read of 'something changed here')", () => {
    const kind = hunkKind(
      {
        kind: "text",
        hunkId: "h1",
        operationIds: ["missing"],
        relStart: {} as never,
        relEnd: {} as never,
        spans: [],
      },
      new Map(),
    );
    expect(kind).toBe("agent");
  });
});
