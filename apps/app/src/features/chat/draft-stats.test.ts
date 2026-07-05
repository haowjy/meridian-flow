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
  it("prefers word deltas when present", () => {
    const stats = draftStats(
      draft({ proposedOperationCount: 3 } as Partial<ThreadDraftListItem>) as ThreadDraftListItem &
        Record<string, number>,
    );
    // No word fields → falls back to edits.
    expect(stats).toEqual({ kind: "edits", count: 3 });
  });

  it("uses word deltas over edit count when the forward-compat fields exist", () => {
    const withWords = {
      ...draft({ proposedOperationCount: 3 }),
      wordsAdded: 40,
      wordsRemoved: 12,
    } as ThreadDraftListItem;
    expect(draftStats(withWords)).toEqual({ kind: "words", added: 40, removed: 12 });
  });

  it("returns null when no magnitude is available", () => {
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
