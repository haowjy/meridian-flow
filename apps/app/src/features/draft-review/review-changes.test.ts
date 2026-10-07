/**
 * reviewChanges — one change per server closure class, in document order.
 *
 * Pins the grouping (never repaired on the client), document order from the
 * hunks, and the signals a row or bar reads: colour, "Includes your edits",
 * merged, and who made it.
 */
import type { ReviewHunk, ReviewOperation } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import { reviewChanges } from "./review-changes";

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

  it("marks a change merged only when authorship cannot be read from its spans", () => {
    const ops = [
      op({ operationId: "a", closureClassId: "c" }),
      op({ operationId: "w", kind: "writer", closureClassId: "c" }),
    ];
    // Writer typed inside the AI's text: ai, writer, ai at most. Readable, so not merged.
    const readable = textHunk({
      hunkId: "h",
      operationIds: ["a", "w"],
      mergeArtifact: true,
      spans: [
        { operationId: "a", anchorFrom: "", anchorTo: "" },
        { operationId: "w", anchorFrom: "", anchorTo: "" },
        { operationId: "a", anchorFrom: "", anchorTo: "" },
      ],
    } as Partial<ReviewHunk> & { hunkId: string });
    expect(reviewChanges(ops, [readable])[0].merged).toBe(false);
    // No spans at all: the server could not split it.
    const blurred = textHunk({ hunkId: "h", operationIds: ["a", "w"], mergeArtifact: true });
    const [merged] = reviewChanges(ops, [blurred]);
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
    const [unknown] = reviewChanges([op({ operationId: "3" })], []);
    expect(unknown.attribution).toEqual({ kind: "ai" });
  });
});
