/**
 * reviewChanges — one change per server closure class, in document order.
 *
 * Pins the grouping (never repaired on the client), document order from the
 * hunks, and the signals a row or bar reads: colour, "Includes your edits",
 * merged, and who made it.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import { changeExcerpt, reviewChanges } from "./review-changes";

function op(overrides: Partial<ReviewOperation> & { operationId: string }): ReviewOperation {
  return {
    closureClassId: `closure:${overrides.operationId}`,
    kind: "agent",
    contribution: "added",
    classification: "addition",
    hunkCount: 1,
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

  it("marks a change merged when the server flags a merge artifact, and only then", () => {
    const ops = [
      op({ operationId: "a", closureClassId: "c" }),
      op({ operationId: "w", kind: "writer", closureClassId: "c" }),
    ];
    // A writer typing inside AI text is readable by author: the server does not flag it.
    const plain = textHunk({ hunkId: "h", operationIds: ["a", "w"] });
    expect(reviewChanges(ops, [plain])[0].merged).toBe(false);
    const flagged = textHunk({ hunkId: "h", operationIds: ["a", "w"], mergeArtifact: true });
    const [merged] = reviewChanges(ops, [flagged]);
    expect(merged.merged).toBe(true);
    expect(merged.tone).toBe("merged");
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

    it("lists a chat's change under that chat only when one of its operations is visible in it", () => {
      const changes = reviewChanges(
        [
          written("1", "t-pace", "Pacing pass", {}, { closureClassId: "c1" }),
          written("2", "t-lore", "Lore pass", {}, { closureClassId: "c1" }),
          written("3", "t-lore", "Lore pass", {}, { closureClassId: "c2" }),
        ],
        [],
      );
      const of = (threadId: string) =>
        changes.filter((change) => change.threadIds.includes(threadId)).map((c) => c.classId);
      expect(of("t-pace")).toEqual(["c1"]);
      expect(of("t-lore")).toEqual(["c1", "c2"]);
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

  describe("what the server could not attribute", () => {
    const unclassified = (overrides: Partial<ReviewHunk> & { hunkId: string }) =>
      textHunk({ unclassified: true, ...overrides });

    it("keeps the class's author when an unclassified hunk touches it, but offers no commands", () => {
      const ops = [
        op({ operationId: "a", closureClassId: "c", canApplyOrDiscard: false }),
        op({ operationId: "b", closureClassId: "c", canApplyOrDiscard: false }),
      ];
      const hunks = [unclassified({ hunkId: "h", operationIds: ["a"], deletedText: "Alpha" })];
      const [change] = reviewChanges(ops, hunks);
      expect(change.actionable).toBe(false);
      expect(change.attribution).toEqual({ kind: "ai" });
      expect(change.operationIds).toEqual(["a", "b"]);
    });
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
