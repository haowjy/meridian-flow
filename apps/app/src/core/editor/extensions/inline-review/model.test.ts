/**
 * Model tests — pure hunk-decoding logic. No DOM, no editor. Anchors are
 * built here from real `Y.RelativePosition`s so the base64 round-trip is
 * exercised end-to-end.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import { buildInlineReviewModel, decodeAnchor, hunkKind, indexOperations } from "./model";

function encodeAnchor(position: Y.RelativePosition): string {
  const bytes = Y.encodeRelativePosition(position);
  return Buffer.from(bytes).toString("base64");
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

describe("buildInlineReviewModel", () => {
  it("keeps hunks with resolvable anchors and drops the rest", () => {
    const doc = new Y.Doc();
    const good = makeAnchoredHunk(doc, "h1", "op-a");
    const broken: ReviewHunk = {
      hunkId: "h2",
      operationIds: ["op-a"],
      anchor: { relStart: "garbage", relEnd: "garbage" },
      spans: [],
    };

    const model = buildInlineReviewModel({
      draftRevisionToken: 7,
      operations: [
        {
          operationId: "op-a",
          sourceUpdateIds: [1],
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
          sourceUpdateIds: [1],
          rejectSourceUpdateIds: [1],
          kind: "agent",
          contribution: "edited",
          classification: "rewrite",
          hunkCount: 1,
        },
      ],
      hunks: [hunk],
    });
    expect(model.hunks[0].deletedText).toBe("removed prose");
  });
});

describe("hunkKind", () => {
  function operation(id: string, kind: "agent" | "writer"): ReviewOperation {
    return {
      operationId: id,
      sourceUpdateIds: [1],
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
        hunkId: "h1",
        operationIds: ["op-a", "op-b"],
        relStart: {} as never,
        relEnd: {} as never,
      },
      map,
    );
    expect(kind).toBe("writer");
  });

  it("returns agent when every contributing operation is AI-attributed", () => {
    const map = indexOperations([operation("op-a", "agent")]);
    const kind = hunkKind(
      { hunkId: "h1", operationIds: ["op-a"], relStart: {} as never, relEnd: {} as never },
      map,
    );
    expect(kind).toBe("agent");
  });

  it("falls back to agent when no operation is known (best-effort read of 'something changed here')", () => {
    const kind = hunkKind(
      { hunkId: "h1", operationIds: ["missing"], relStart: {} as never, relEnd: {} as never },
      new Map(),
    );
    expect(kind).toBe("agent");
  });
});
