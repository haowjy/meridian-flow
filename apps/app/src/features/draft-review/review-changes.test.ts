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
  it("groups by the server-vended closureClassId", () => {
    const ops = [
      op({ operationId: "a", closureClassId: "c1" }),
      op({ operationId: "b", closureClassId: "c1" }),
      op({ operationId: "c", closureClassId: "c2" }),
    ];
    const changes = reviewChanges(ops, []);
    expect(changes.map((change) => change.classId)).toEqual(["c1", "c2"]);
    expect(changes[0].operationIds).toEqual(["a", "b"]);
  });

  it("does not reconstruct or repair server class identities", () => {
    const ops = [
      op({ operationId: "a", closureClassId: "closure:a" }),
      op({ operationId: "b", closureClassId: "closure:a+b" }),
    ];
    const hunks = [textHunk({ hunkId: "h", operationIds: ["a", "b"] })];
    expect(reviewChanges(ops, hunks)).toHaveLength(2);
  });

  it("orders changes by where their first hunk sits, not by operation order", () => {
    const ops = [op({ operationId: "11" }), op({ operationId: "6" }), op({ operationId: "9" })];
    const hunks = [
      textHunk({ hunkId: "h1", operationIds: ["6"] }),
      textHunk({ hunkId: "h2", operationIds: ["9"] }),
      textHunk({ hunkId: "h3", operationIds: ["11"] }),
    ];
    expect(reviewChanges(ops, hunks).map((change) => change.operationIds[0])).toEqual([
      "6",
      "9",
      "11",
    ]);
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

  it("anchors a change on the operation that owns its earliest hunk", () => {
    const ops = [
      op({ operationId: "a", closureClassId: "c" }),
      op({ operationId: "b", closureClassId: "c" }),
    ];
    const hunks = [
      textHunk({ hunkId: "h1", operationIds: ["b"] }),
      textHunk({ hunkId: "h2", operationIds: ["a"] }),
    ];
    expect(reviewChanges(ops, hunks)[0].anchorOperationId).toBe("b");
  });

  it("flags includesWriterEdits when a writer op joins the class", () => {
    const ops = [
      op({ operationId: "a", kind: "agent", closureClassId: "closure:a+w" }),
      op({
        operationId: "w",
        kind: "writer",
        contribution: "edited",
        classification: "rewrite",
        closureClassId: "closure:a+w",
      }),
    ];
    const [change] = reviewChanges(ops, []);
    expect(change.includesWriterEdits).toBe(true);
    expect(change.tone).toBe("ai");
  });

  it("reads a class of only the writer's operations as the writer's", () => {
    const [change] = reviewChanges([op({ operationId: "w", kind: "writer" })], []);
    expect(change.tone).toBe("writer");
    expect(change.attribution).toEqual({ kind: "you" });
  });

  it("reads an AI-only removal as a removal", () => {
    const [change] = reviewChanges([op({ operationId: "r", classification: "removal" })], []);
    expect(change.tone).toBe("removal");
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

  it("links the change to the latest AI operation's chat, else plain AI", () => {
    const withThread = (id: string, threadId: string | null, title: string | null) =>
      ({
        ...op({ operationId: id, closureClassId: "c" }),
        actorThreadId: threadId,
        actorThreadTitle: title,
      }) as ReviewOperation;
    const [linked] = reviewChanges(
      [withThread("2", "t-old", "Old chat"), withThread("9", "t-new", "Line edit")],
      [],
    );
    expect(linked.attribution).toEqual({ kind: "chat", threadId: "t-new", title: "Line edit" });
    const [blank] = reviewChanges([withThread("5", "t-blank", "  ")], []);
    expect(blank.attribution).toEqual({ kind: "chat", threadId: "t-blank", title: null });
    const [unknown] = reviewChanges([op({ operationId: "3" })], []);
    expect(unknown.attribution).toEqual({ kind: "ai" });
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

    it("lists an unclassified hunk with no operation as a change with no author and no commands", () => {
      const hunks = [
        textHunk({ hunkId: "h1", operationIds: ["a"] }),
        unclassified({ hunkId: "h2", deletedText: "Alpha", deletedSpans: [] }),
      ];
      const changes = reviewChanges([op({ operationId: "a" })], hunks);
      expect(changes).toHaveLength(2);
      const [classified, loose] = changes;
      expect(classified.actionable).toBe(true);
      expect(loose).toMatchObject({
        attribution: { kind: "unattributed" },
        actionable: false,
        operationIds: [],
        tone: "unattributed",
        includesWriterEdits: false,
      });
      expect(loose.classId).toBe(loose.anchorOperationId);
      expect(loose.markKeys).toEqual([loose.anchorOperationId]);
      // The full removal, not an author's share of it.
      expect(changeExcerpt(loose)).toEqual({ added: null, removed: "Alpha" });
    });

    it("reads an unclassified insertion from insertedText", () => {
      const [loose] = reviewChanges([], [unclassified({ hunkId: "h", insertedText: "Beta" })]);
      expect(changeExcerpt(loose)).toEqual({ added: "Beta", removed: null });
    });

    it("keeps a block hunk's own displays", () => {
      const block = {
        kind: "block",
        hunkId: "b",
        operationIds: [],
        unclassified: true,
        anchor: { relStart: "", relEnd: "" },
        deletedBlock: { type: "paragraph", display: "A removed paragraph" },
      } as ReviewHunk;
      const [loose] = reviewChanges([], [block]);
      expect(changeExcerpt(loose)).toEqual({ added: null, removed: "A removed paragraph" });
    });

    it("places it where it sits in the document, among the classified changes", () => {
      const hunks = [
        textHunk({ hunkId: "h1", operationIds: ["a"] }),
        unclassified({ hunkId: "h2", deletedText: "x" }),
        textHunk({ hunkId: "h3", operationIds: ["b"] }),
      ];
      const changes = reviewChanges([op({ operationId: "a" }), op({ operationId: "b" })], hunks);
      expect(changes.map((change) => change.attribution.kind)).toEqual([
        "ai",
        "unattributed",
        "ai",
      ]);
    });

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

    it("treats an absent flag as ordinary eligibility", () => {
      const [change] = reviewChanges([op({ operationId: "a" })], []);
      expect(change.actionable).toBe(true);
    });
  });
});
