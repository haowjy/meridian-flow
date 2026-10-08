/**
 * operationChangeText — card-body extraction from preview operations/hunks.
 * Regression anchor: probe p2265 found a real addition draft whose only
 * content-bearing hunks were horizontal_rule blocks ("───"), which rendered a
 * card body of separators instead of falling back to the prose excerpt.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import { changeTextForHunks, operationsWithWriterEdits } from "./operation-change-text";

/** What a class of these operations reads as: the hunks they own, with their excerpts as fallback. */
function changeTextForOperations(operations: readonly ReviewOperation[], hunks: ReviewHunk[]) {
  const ids = new Set(operations.map((op) => op.operationId));
  return changeTextForHunks(
    hunks.filter((hunk) => hunk.operationIds.some((id) => ids.has(id))),
    operations,
  );
}

/** A single-operation class is the single-card body — the common case here. */
function operationChangeText(operation: ReviewOperation, hunks: ReviewHunk[]) {
  return changeTextForOperations([operation], hunks);
}

function op(overrides: Partial<ReviewOperation>): ReviewOperation {
  return {
    operationId: "4",
    closureClassId: "closure:4",
    kind: "agent",
    contribution: "added",
    classification: "addition",
    hunkCount: 1,
    ...overrides,
  };
}

describe("operationChangeText", () => {
  it("falls back to the excerpt when block displays carry no prose (p2265)", () => {
    const hunks: ReviewHunk[] = [
      {
        kind: "text",
        hunkId: "h1",
        operationIds: ["4"],
        anchor: { relStart: "", relEnd: "" },
        spans: [],
      },
      {
        kind: "block",
        hunkId: "h2",
        operationIds: ["4"],
        anchor: { relStart: "", relEnd: "" },
        insertedBlock: { type: "horizontal_rule", display: "───" },
      },
    ];
    const result = operationChangeText(op({ afterExcerpt: "Chapter 1 — The Waste" }), hunks);
    expect(result.added).toBe("Chapter 1 — The Waste");
    expect(result.removed).toBeNull();
  });

  it("prefers full deleted text and prose block displays over excerpts", () => {
    const hunks: ReviewHunk[] = [
      {
        kind: "text",
        hunkId: "h1",
        operationIds: ["4"],
        anchor: { relStart: "", relEnd: "" },
        spans: [],
        deletedText: "He was, by every measure, a waste.",
      },
      {
        kind: "block",
        hunkId: "h2",
        operationIds: ["4"],
        anchor: { relStart: "", relEnd: "" },
        insertedBlock: { type: "paragraph", display: "Something ancient stirred." },
      },
    ];
    const result = operationChangeText(
      op({ classification: "rewrite", beforeExcerpt: "He was…", afterExcerpt: "Something…" }),
      hunks,
    );
    expect(result.removed).toBe("He was, by every measure, a waste.");
    expect(result.added).toBe("Something ancient stirred.");
  });

  it("ignores hunks belonging to other operations", () => {
    const hunks: ReviewHunk[] = [
      {
        kind: "text",
        hunkId: "h1",
        operationIds: ["9"],
        anchor: { relStart: "", relEnd: "" },
        spans: [],
        deletedText: "Unrelated.",
      },
    ];
    const result = operationChangeText(op({}), hunks);
    expect(result.removed).toBeNull();
    expect(result.added).toBeNull();
  });
});

describe("a change that includes the writer's edits", () => {
  // The real preview of an AI replacement the writer typed " frail" into: the
  // AI operation and the writer's report the same text after the edit.
  const hunks: ReviewHunk[] = [
    {
      kind: "text",
      hunkId: "h1",
      operationIds: ["61", "writer:66"],
      anchor: { relStart: "", relEnd: "" },
      spans: [],
      deletedText: "his",
    },
  ];
  const agent = op({
    operationId: "61",
    classification: "rewrite",
    beforeExcerpt: "his",
    afterExcerpt: "one withered frail",
  });
  const writer = op({
    operationId: "writer:66",
    kind: "writer",
    classification: "rewrite",
    beforeExcerpt: "his",
    afterExcerpt: "one withered frail",
  });

  it("reads the text once", () => {
    expect(changeTextForOperations([agent, writer], hunks)).toEqual({
      removed: "his",
      added: "one withered frail",
    });
  });

  it("keeps the longer text when one operation's excerpt contains the other's", () => {
    const shorter = { ...agent, afterExcerpt: "one withered" };
    expect(changeTextForOperations([shorter, writer], hunks).added).toBe("one withered frail");
    expect(changeTextForOperations([writer, shorter], hunks).added).toBe("one withered frail");
  });

  it("keeps separate texts separate", () => {
    const other = { ...writer, afterExcerpt: "a second thought" };
    expect(changeTextForOperations([agent, other], hunks).added).toBe(
      "one withered frail\na second thought",
    );
  });
});

describe("operationsWithWriterEdits", () => {
  const textHunk = (hunkId: string, operationIds: string[]): ReviewHunk => ({
    kind: "text",
    hunkId,
    operationIds,
    anchor: { relStart: "", relEnd: "" },
    spans: [],
  });

  it("flags the agent op when a hunk also carries a writer op", () => {
    const operations = [
      op({ operationId: "agent-1", kind: "agent" }),
      op({ operationId: "writer-1", kind: "writer" }),
    ];
    const mixed = operationsWithWriterEdits(operations, [textHunk("h1", ["agent-1", "writer-1"])]);

    // Only the agent op is flagged — a card never discards the writer's own op.
    expect([...mixed]).toEqual(["agent-1"]);
  });

  it("does not flag agent-only or writer-only hunks", () => {
    const operations = [
      op({ operationId: "agent-1", kind: "agent" }),
      op({ operationId: "agent-2", kind: "agent" }),
      op({ operationId: "writer-1", kind: "writer" }),
    ];
    const mixed = operationsWithWriterEdits(operations, [
      textHunk("h1", ["agent-1", "agent-2"]),
      textHunk("h2", ["writer-1"]),
    ]);

    expect(mixed.size).toBe(0);
  });
});
