/**
 * reviewChanges — one change per server closure class, in document order.
 *
 * Pins the grouping (never repaired on the client), document order from the
 * hunks, and the signals a row or bar reads: colour, "Includes your edits",
 * merged, and who made it.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import {
  changeExcerpt,
  resolveFocusedChange,
  reviewChanges,
  reviewChangesOfPreview,
} from "./review-changes";

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

    it("links a single chat at its own turn and tool call, else plain AI", () => {
      const [linked] = reviewChanges(
        [written("2", "t-one", "Line edit", { actorTurnId: "turn-7", actorToolCallId: "call-3" })],
        [],
      );
      expect(linked.attribution).toEqual({
        kind: "chats",
        chats: [{ threadId: "t-one", title: "Line edit", turnId: "turn-7", toolCallId: "call-3" }],
      });
      const [blank] = reviewChanges([written("5", "t-blank", "  ")], []);
      expect(blank.attribution).toEqual({
        kind: "chats",
        chats: [{ threadId: "t-blank", title: null, turnId: null, toolCallId: null }],
      });
      const [unknown] = reviewChanges([op({ operationId: "3" })], []);
      expect(unknown.attribution).toEqual({ kind: "ai" });
      expect(unknown.threadIds).toEqual([]);
    });

    it("names every chat of the class, latest first, each at its own latest write", () => {
      const [change] = reviewChanges(
        [
          written("3", "t-lore", "Lore pass", { actorTurnId: "turn-a", actorToolCallId: "call-a" }),
          written("12", "t-pace", "Pacing pass", {
            actorTurnId: "turn-b",
            actorToolCallId: "call-b",
          }),
          // The same chat wrote twice: its later write is the one its link opens.
          written("7", "t-lore", "Lore pass", { actorTurnId: "turn-c", actorToolCallId: "call-c" }),
        ],
        [],
      );
      expect(change.attribution).toEqual({
        kind: "chats",
        chats: [
          { threadId: "t-pace", title: "Pacing pass", turnId: "turn-b", toolCallId: "call-b" },
          { threadId: "t-lore", title: "Lore pass", turnId: "turn-c", toolCallId: "call-c" },
        ],
      });
      expect(change.threadIds).toEqual(["t-pace", "t-lore"]);
    });

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
        threadIds: [],
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

describe("reviewChangesOfPreview", () => {
  it("derives a preview's changes once, for every reader", () => {
    const preview = {
      status: "active",
      inlineModelPresent: true,
      operations: [op({ operationId: "a", closureClassId: "c1" })],
      hunks: [textHunk({ hunkId: "h1", operationIds: ["a"] })],
    } as never;
    expect(reviewChangesOfPreview(preview)).toBe(reviewChangesOfPreview(preview));
  });
});

describe("resolveFocusedChange", () => {
  const ops = [
    op({ operationId: "1", closureClassId: "c1" }),
    op({ operationId: "2", closureClassId: "c2b" }),
    op({ operationId: "5", closureClassId: "c2b" }),
  ];
  const changes = reviewChanges(ops, []);

  it("finds the class by id", () => {
    expect(resolveFocusedChange(changes, { classId: "c1", operationIds: ["1"] })?.classId).toBe(
      "c1",
    );
  });

  it("finds a regrouped class by an operation it kept", () => {
    expect(resolveFocusedChange(changes, { classId: "c2", operationIds: ["2"] })?.classId).toBe(
      "c2b",
    );
  });

  it("names nothing when the class and all its operations are gone, or nothing is focused", () => {
    expect(resolveFocusedChange(changes, { classId: "c9", operationIds: ["9"] })).toBeNull();
    expect(resolveFocusedChange(changes, { classId: "c9", operationIds: [] })).toBeNull();
    expect(resolveFocusedChange(changes, null)).toBeNull();
  });
});
