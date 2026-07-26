/** Unit coverage for server-vended selective-Discard classes. */

import { describe, expect, it } from "vitest";
import { assignDiscardClasses } from "./branch-review-closure.js";
import type {
  DraftReviewHunkInternal,
  DraftReviewOperationInternal,
} from "./draft-review-types.js";

function op(
  id: string,
  sourceUpdateIds: number[],
  discardUpdateIds = sourceUpdateIds,
): Omit<DraftReviewOperationInternal, "closureClassId"> {
  return {
    operationId: id,
    sourceUpdateIds,
    discardUpdateIds,
    kind: "agent",
    contribution: "added",
    classification: "addition",
    hunkCount: 1,
  };
}

function hunk(id: string, operationIds: string[]): DraftReviewHunkInternal {
  return {
    kind: "block",
    hunkId: id,
    operationIds,
    anchor: { relStart: "0", relEnd: "0" },
  };
}

describe("assignDiscardClasses", () => {
  it("joins operations whose discard closures share a physical row", () => {
    const operations = assignDiscardClasses({
      operations: [op("a", [1], [1, 2]), op("b", [2], [2])],
      hunks: [hunk("h1", ["a"]), hunk("h2", ["b"])],
    });

    expect(new Set(operations.map((operation) => operation.closureClassId))).toEqual(
      new Set(["closure:a+b"]),
    );
    expect(operations.map((operation) => operation.discardUpdateIds)).toEqual([
      [1, 2],
      [1, 2],
    ]);
  });

  it("does not join operations only because one Apply source set contains the other", () => {
    const operations = assignDiscardClasses({
      operations: [op("a", [1], [1]), op("b", [1, 2], [2])],
      hunks: [hunk("h1", ["a"]), hunk("h2", ["b"])],
    });

    expect(operations.map((operation) => operation.closureClassId)).toEqual([
      "closure:a",
      "closure:b",
    ]);
  });

  it("joins operations that share a visible hunk", () => {
    const operations = assignDiscardClasses({
      operations: [op("a", [1]), op("b", [2])],
      hunks: [hunk("h1", ["a", "b"])],
    });

    expect(new Set(operations.map((operation) => operation.closureClassId))).toEqual(
      new Set(["closure:a+b"]),
    );
    expect(operations.map((operation) => operation.discardUpdateIds)).toEqual([
      [1, 2],
      [1, 2],
    ]);
  });
});
