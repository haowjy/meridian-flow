/** Unit coverage for server-vended review closure classes. */

import { describe, expect, it } from "vitest";
import { enrichAcceptClosureOperationIds } from "./draft-accept-closure.js";
import type {
  DraftReviewHunkInternal,
  DraftReviewOperationInternal,
} from "./draft-review-types.js";

function op(
  id: string,
  acceptUpdateIds: number[],
  rejectUpdateIds = acceptUpdateIds,
): DraftReviewOperationInternal {
  return {
    operationId: id,
    rejectSourceUpdateIds: rejectUpdateIds,
    sourceUpdateIds: acceptUpdateIds,
    directionalClosure: {
      accept: { updateIds: acceptUpdateIds },
      reject: { updateIds: rejectUpdateIds },
    },
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

describe("enrichAcceptClosureOperationIds", () => {
  it("vends one class for an A<-B dependency and carries the full closure row set", () => {
    const operations = enrichAcceptClosureOperationIds({
      operations: [op("a", [1]), op("b", [1, 2])],
      hunks: [hunk("h1", ["a"]), hunk("h2", ["b"])],
      updates: [],
      partitionClasses: true,
    });

    expect(new Set(operations.map((operation) => operation.closureClassId))).toEqual(
      new Set(["closure:a+b"]),
    );
    expect(operations.map((operation) => operation.acceptClosureOperationIds)).toEqual([
      ["a", "b"],
      ["a", "b"],
    ]);
    expect(operations.map((operation) => operation.directionalClosure.accept.updateIds)).toEqual([
      [1, 2],
      [1, 2],
    ]);
  });

  it("keeps disjoint operations in separate closure classes", () => {
    const operations = enrichAcceptClosureOperationIds({
      operations: [op("a", [1]), op("b", [2])],
      hunks: [hunk("h1", ["a"]), hunk("h2", ["b"])],
      updates: [],
      partitionClasses: true,
    });

    expect(operations.map((operation) => operation.closureClassId)).toEqual([
      "closure:a",
      "closure:b",
    ]);
  });
});
