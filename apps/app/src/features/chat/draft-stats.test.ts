import type { ThreadDraftListItem } from "@meridian/contracts/drafts";
import { describe, expect, it } from "vitest";

import { aggregateDraftStats, draftStats } from "./draft-stats";

function draft(input: Partial<ThreadDraftListItem> = {}): ThreadDraftListItem {
  return {
    draftId: "draft-1",
    documentId: "doc-1",
    documentName: "Chapter 1",
    contextPath: null,
    status: "active",
    lastActorTurnId: null,
    updatedAt: "2026-07-04T00:00:00.000Z",
    appliedAt: null,
    discardedAt: null,
    wordsAdded: null,
    wordsRemoved: null,
    ...input,
  };
}

describe("draftStats", () => {
  it("uses word deltas when the wire row has word counts", () => {
    expect(
      draftStats(draft({ proposedOperationCount: 3, wordsAdded: 40, wordsRemoved: 12 })),
    ).toEqual({
      kind: "words",
      added: 40,
      removed: 12,
    });
  });

  it("falls back to edit count when the real wire row has null word fields", () => {
    expect(draftStats(draft({ proposedOperationCount: 3 }))).toEqual({
      kind: "edits",
      count: 3,
    });
  });

  it("returns null when the real wire row has no magnitude", () => {
    expect(draftStats(draft())).toBeNull();
  });
});

describe("aggregateDraftStats", () => {
  it("sums edit counts across documents", () => {
    const stats = aggregateDraftStats([
      draft({ proposedOperationCount: 2 }),
      draft({ proposedOperationCount: 5 }),
    ]);
    expect(stats).toEqual({ kind: "edits", count: 7 });
  });

  it("degrades to null when documents mix magnitude kinds", () => {
    const stats = aggregateDraftStats([draft({ proposedOperationCount: 2 }), draft()]);
    expect(stats).toBeNull();
  });
});
