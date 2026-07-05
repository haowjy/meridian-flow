/**
 * operationChangeText — card-body extraction from preview operations/hunks.
 * Regression anchor: probe p2265 found a real addition draft whose only
 * content-bearing hunks were horizontal_rule blocks ("───"), which rendered a
 * card body of separators instead of falling back to the prose excerpt.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import { operationChangeText } from "./DockChangesView";

function op(overrides: Partial<ReviewOperation>): ReviewOperation {
  return {
    operationId: "4",
    rejectSourceUpdateIds: [],
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
