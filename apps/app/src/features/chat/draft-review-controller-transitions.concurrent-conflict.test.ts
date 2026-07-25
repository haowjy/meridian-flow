/** Concurrent push conflicts keep review open and mark the affected blocks. */
import { describe, expect, it } from "vitest";
import {
  conflictForSelection,
  draftApplyOutcome,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
} from "./draft-review-session";

describe("draft review concurrent conflict", () => {
  it("keeps the draft pending in needs-re-review state", () => {
    const entered = draftReviewReducer(EMPTY_DRAFT_REVIEW_STATE, {
      type: "enterInline",
      documentId: "document-1",
      draftId: "draft-1",
    });
    const reviewing = draftReviewReducer(entered, {
      type: "inlineModelAvailable",
      documentId: "document-1",
      draftId: "draft-1",
      identity: "draft-1:live-1:draft-1",
    });

    const conflicted = draftReviewReducer(reviewing, {
      type: "applySucceeded",
      documentId: "document-1",
      draftId: "draft-1",
      outcome: draftApplyOutcome("draft", {
        status: "concurrent_conflict",
        reason: "draft_base_divergence",
        conflictedBlocks: ["block-a"],
        conflicts: [],
      }),
    });

    expect(conflicted.surface).toMatchObject({ kind: "inline", draftId: "draft-1" });
    expect(conflicted.applyRefusal).toMatchObject({
      documentId: "document-1",
      draftId: "draft-1",
      reason: "unsynced_live_edits",
      conflictedBlocks: ["block-a"],
    });

    const conflictDecorated = draftReviewReducer(conflicted, {
      type: "inlineModelAvailable",
      documentId: "document-1",
      draftId: "draft-1",
      identity: "draft-1:live-1:draft-1",
    });
    expect(conflictDecorated).toBe(conflicted);
    expect(conflictDecorated.applyRefusal).not.toBeNull();
    expect(
      conflictForSelection(conflicted, { documentId: "document-1", draftId: "draft-1" }),
    ).toEqual({
      documentId: "document-1",
      draftId: "draft-1",
      conflictedBlocks: ["block-a"],
    });

    const navigated = draftReviewReducer(conflictDecorated, {
      type: "enterInline",
      documentId: "document-2",
      draftId: "draft-2",
    });
    expect(
      conflictForSelection(navigated, { documentId: "document-1", draftId: "draft-1" }),
    ).not.toBeNull();
    expect(navigated.applyRefusal).toBeNull();

    const returned = draftReviewReducer(navigated, {
      type: "enterInline",
      documentId: "document-1",
      draftId: "draft-1",
    });
    const loaded = draftReviewReducer(returned, {
      type: "inlineModelAvailable",
      documentId: "document-1",
      draftId: "draft-1",
      identity: "preview-before-conflict",
    });
    const rereviewed = draftReviewReducer(loaded, {
      type: "inlineModelAvailable",
      documentId: "document-1",
      draftId: "draft-1",
      identity: "preview-after-conflict",
    });
    expect(
      conflictForSelection(rereviewed, { documentId: "document-1", draftId: "draft-1" }),
    ).toBeNull();
    expect(rereviewed.applyRefusal).toBeNull();
  });
});
