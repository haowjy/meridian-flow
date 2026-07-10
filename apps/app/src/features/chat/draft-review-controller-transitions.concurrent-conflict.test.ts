/** Concurrent push conflicts keep review open and mark the affected blocks. */
import { describe, expect, it } from "vitest";
import {
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
} from "./draft-review-controller-transitions";

describe("draft review concurrent conflict", () => {
  it("keeps the draft pending in needs-re-review state", () => {
    const reviewing = draftReviewReducer(EMPTY_DRAFT_REVIEW_STATE, {
      type: "enterInline",
      documentId: "document-1",
      draftId: "draft-1",
    });

    const conflicted = draftReviewReducer(reviewing, {
      type: "applySucceeded",
      documentId: "document-1",
      draftId: "draft-1",
      response: { status: "concurrent_conflict", conflictedBlocks: ["block-a"] },
    });

    expect(conflicted.surface).toMatchObject({ kind: "inline", draftId: "draft-1" });
    expect(conflicted.concurrentConflict).toEqual({
      documentId: "document-1",
      draftId: "draft-1",
      conflictedBlocks: ["block-a"],
    });
  });
});
