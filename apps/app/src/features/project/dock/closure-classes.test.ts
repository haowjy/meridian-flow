/**
 * partitionClosureClasses — closure=card partition (spec §5.3).
 *
 * The review surface renders one proposal card per closure class, never per
 * operation. These tests pin the grouping (server-vended id first, connected
 * components as the pre-wire fallback) and the per-card signals a card reads:
 * summary verb, merged flag, "Includes your edits", and turn attribution.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import { partitionClosureClasses } from "./closure-classes";

function op(overrides: Partial<ReviewOperation> & { operationId: string }): ReviewOperation {
  return {
    rejectSourceUpdateIds: [],
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

describe("partitionClosureClasses", () => {
  it("groups by the server-vended closureClassId when present", () => {
    const ops = [
      op({ operationId: "a", closureClassId: "c1" }),
      op({ operationId: "b", closureClassId: "c1" }),
      op({ operationId: "c", closureClassId: "c2" }),
    ];
    const classes = partitionClosureClasses(ops, []);
    expect(classes).toHaveLength(2);
    expect(classes[0].classId).toBe("c1");
    expect(classes[0].operations.map((o) => o.operationId)).toEqual(["a", "b"]);
    expect(classes[1].operations.map((o) => o.operationId)).toEqual(["c"]);
  });

  it("falls back to connected components over accept-closure ids", () => {
    // No closureClassId → derive: a drags b (causal), c is independent.
    const ops = [
      op({ operationId: "a", acceptClosureOperationIds: ["a", "b"] }),
      op({ operationId: "b" }),
      op({ operationId: "c" }),
    ];
    const classes = partitionClosureClasses(ops, []);
    expect(classes).toHaveLength(2);
    expect(classes[0].operations.map((o) => o.operationId).sort()).toEqual(["a", "b"]);
    expect(classes[1].operations.map((o) => o.operationId)).toEqual(["c"]);
  });

  it("unions operations that share a hunk (hunk-sharing joins the class)", () => {
    const ops = [op({ operationId: "a" }), op({ operationId: "b" })];
    const hunks = [textHunk({ hunkId: "h", operationIds: ["a", "b"] })];
    const classes = partitionClosureClasses(ops, hunks);
    expect(classes).toHaveLength(1);
    expect(classes[0].operations.map((o) => o.operationId).sort()).toEqual(["a", "b"]);
  });

  it("flags includesWriterEdits when a writer op joins the class", () => {
    const ops = [
      op({ operationId: "a", kind: "agent", acceptClosureOperationIds: ["a", "w"] }),
      op({ operationId: "w", kind: "writer", contribution: "edited", classification: "rewrite" }),
    ];
    const [proposal] = partitionClosureClasses(ops, []);
    expect(proposal.includesWriterEdits).toBe(true);
    // The verbs run against an agent representative, not the writer row.
    expect(proposal.primaryOperation.kind).toBe("agent");
  });

  it("marks a class merged when any contributing hunk is a merge artifact", () => {
    const ops = [op({ operationId: "a" })];
    const hunks = [textHunk({ hunkId: "h", operationIds: ["a"], mergeArtifact: true })];
    const [proposal] = partitionClosureClasses(ops, hunks);
    expect(proposal.merged).toBe(true);
  });

  it("summarizes classification: mixed add + remove reads as a rewrite", () => {
    const ops = [
      op({ operationId: "a", classification: "addition", closureClassId: "c" }),
      op({ operationId: "b", classification: "removal", closureClassId: "c" }),
    ];
    const [proposal] = partitionClosureClasses(ops, []);
    expect(proposal.classification).toBe("rewrite");
  });

  it("attributes every distinct contributing turn", () => {
    const ops = [
      op({ operationId: "a", actorTurnId: "t1", closureClassId: "c" }),
      op({ operationId: "b", actorTurnId: "t2", closureClassId: "c" }),
      op({ operationId: "d", actorTurnId: "t1", closureClassId: "c" }),
    ];
    const [proposal] = partitionClosureClasses(ops, []);
    expect(proposal.contributingTurnIds.sort()).toEqual(["t1", "t2"]);
  });
});
