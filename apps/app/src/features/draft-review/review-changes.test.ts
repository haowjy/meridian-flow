/**
 * reviewChanges — one change per server closure class, in document order.
 *
 * Pins the grouping (never repaired on the client), document order from the
 * hunks, visible author attribution and class-owned excerpts.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import { changeExcerpt, reviewChanges } from "./review-changes";

function op(overrides: Partial<ReviewOperation> & { operationId: string }): ReviewOperation {
  return {
    closureClassId: `closure:${overrides.operationId}`,
    kind: "agent",
    classification: "addition",
    ...overrides,
  };
}

function textHunk(overrides: Partial<ReviewHunk> & { hunkId: string }): ReviewHunk {
  return {
    kind: "text",
    operationIds: [],
    anchor: { relStart: "", relEnd: "" },
    spans: [],
    ...overrides,
  } as ReviewHunk;
}

describe("reviewChanges", () => {
  it("does not reconstruct or repair server class identities", () => {
    const ops = [
      op({ operationId: "a", closureClassId: "closure:a" }),
      op({ operationId: "b", closureClassId: "closure:a+b" }),
    ];
    const hunks = [textHunk({ hunkId: "h", operationIds: ["a", "b"] })];
    expect(reviewChanges(ops, hunks)).toHaveLength(2);
  });

  it("keeps the same order when a refreshed preview lists the same operations differently", () => {
    // Two changes share the hunk that places them and one has no hunk at all: ties break on the class id.
    const ops = [
      op({ operationId: "a", closureClassId: "c-b" }),
      op({ operationId: "b", closureClassId: "c-a" }),
      op({ operationId: "c", closureClassId: "c-z" }),
    ];
    const hunks = [textHunk({ hunkId: "h", operationIds: ["a", "b"] })];
    const ids = (list: ReviewOperation[]) => reviewChanges(list, hunks).map((c) => c.classId);
    expect(ids(ops)).toEqual(["c-a", "c-b", "c-z"]);
    expect(ids([...ops].reverse())).toEqual(ids(ops));
  });

  describe("who wrote a change", () => {
    const written = (
      id: string,
      threadId: string | null,
      title: string | null,
      where: { actorTurnId?: string; actorToolCallId?: string } = {},
      overrides: Partial<ReviewOperation> = {},
    ) =>
      ({
        ...op({ operationId: id, closureClassId: "c" }),
        actorThreadId: threadId,
        actorThreadTitle: title,
        ...where,
        ...overrides,
      }) as ReviewOperation;

    it("orders chats by journal order, not by the order the server lists operations", () => {
      const [change] = reviewChanges(
        [written("10", "t-late", null), written("9", "t-early", null)],
        [],
      );
      expect(change.threadIds).toEqual(["t-late", "t-early"]);
    });

    it("names only chats with a visible operation: writer edits and unthreaded writes name none", () => {
      const [change] = reviewChanges(
        [
          written("4", "t-pace", "Pacing pass"),
          written("6", null, null),
          { ...op({ operationId: "writer:8", kind: "writer", closureClassId: "c" }) },
        ],
        [],
      );
      expect(change.threadIds).toEqual(["t-pace"]);
      // The class's physical suppliers are not operations of it: they arrive as
      // `closureUpdateIds` on the server and are never read here.
      const [writerOnly] = reviewChanges(
        [op({ operationId: "writer:2", kind: "writer", closureClassId: "w" })],
        [],
      );
      expect(writerOnly.attribution).toEqual({ kind: "you" });
      expect(writerOnly.threadIds).toEqual([]);
    });
  });

  it("describes a change with the writer's edits inside it once, not once per operation", () => {
    const agent = op({
      operationId: "61",
      closureClassId: "c",
      classification: "rewrite",
      beforeExcerpt: "his",
      afterExcerpt: "one withered frail",
    });
    const writer = op({
      operationId: "writer:66",
      kind: "writer",
      closureClassId: "c",
      classification: "rewrite",
      beforeExcerpt: "his",
      afterExcerpt: "one withered frail",
    });
    const [change] = reviewChanges([agent, writer], []);
    expect(changeExcerpt(change)).toEqual({ added: "one withered frail", removed: "his" });
  });
});

describe("a change's hunks", () => {
  it("reads the text of the hunks its operations own, and of no other class", () => {
    const ops = [
      op({ operationId: "a", closureClassId: "c1" }),
      op({ operationId: "b", closureClassId: "c2" }),
    ];
    const hunks = [
      textHunk({ hunkId: "h1", operationIds: ["a"], deletedText: "old a" }),
      textHunk({ hunkId: "h2", operationIds: ["b"], deletedText: "old b" }),
      textHunk({ hunkId: "h3", operationIds: ["a", "b"], deletedText: "shared" }),
    ];
    const [first, second] = reviewChanges(ops, hunks);
    expect(first.change.removed).toBe("old a\nshared");
    expect(second.change.removed).toBe("old b\nshared");
  });
});
