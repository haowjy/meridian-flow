import { describe, expect, it } from "vitest";

import {
  acceptIsBlocked,
  type DraftReviewState,
  discardCanStart,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  inlineDiscardIsPending,
  inlineReviewFromState,
  pendingDiscardIdsForDraft,
  selectedDraftFromState,
} from "./draft-review-controller-transitions";

const INLINE_STATE: DraftReviewState = draftReviewReducer(EMPTY_DRAFT_REVIEW_STATE, {
  type: "enterInline",
  documentId: "doc-1",
  draftId: "draft-1",
});

describe("draft review controller transitions", () => {
  it("exits inline review after a successful apply", () => {
    const next = draftReviewReducer(INLINE_STATE, {
      type: "applySucceeded",
      documentId: "doc-1",
      draftId: "draft-1",
      response: {
        status: "applied",
        draftId: "draft-1",
        appliedUpdateSeq: 12,
        acceptTurnId: "turn-1",
      },
    });

    expect(selectedDraftFromState(next)).toBeNull();
    expect(inlineReviewFromState(next)).toBeNull();
    expect(next.overlap).toBeNull();
  });

  it("moves inline overlap responses into panel confirmation state", () => {
    const next = draftReviewReducer(INLINE_STATE, {
      type: "applySucceeded",
      documentId: "doc-1",
      draftId: "draft-1",
      response: {
        status: "overlap",
        draftId: "draft-1",
        liveRevisionToken: 9,
        live: "live changed",
        preview: "merged preview",
        overlappingBlocks: ["block-1"],
      },
    });

    expect(selectedDraftFromState(next)).toEqual({ documentId: "doc-1", draftId: "draft-1" });
    expect(inlineReviewFromState(next)).toBeNull();
    expect(next.overlap).toEqual({
      draftId: "draft-1",
      liveRevisionToken: 9,
      live: "live changed",
      preview: "merged preview",
    });
  });

  it("exits inline review after a whole-draft discard", () => {
    const next = draftReviewReducer(INLINE_STATE, { type: "rejectSucceeded", draftId: "draft-1" });

    expect(selectedDraftFromState(next)).toBeNull();
    expect(inlineReviewFromState(next)).toBeNull();
    expect(next.overlap).toBeNull();
  });

  it("clears panel and inline review with one exit transition", () => {
    const next = draftReviewReducer(INLINE_STATE, { type: "exitReview" });

    expect(next.surface).toEqual({ kind: "none" });
    expect(next.overlap).toBeNull();
    expect(next.staleDraft).toBeNull();
  });

  it("tracks proposal discard pending state by draft", () => {
    const draftOnePending = draftReviewReducer(INLINE_STATE, {
      type: "discardStarted",
      draftId: "draft-1",
      operationId: "op-1",
    });

    expect(inlineDiscardIsPending(draftOnePending)).toBe(true);
    expect(pendingDiscardIdsForDraft(draftOnePending, "draft-1").has("op-1")).toBe(true);
    expect(pendingDiscardIdsForDraft(draftOnePending, "draft-2").size).toBe(0);
    expect(discardCanStart(draftOnePending, "draft-1")).toBe(false);
    expect(discardCanStart(draftOnePending, "draft-2")).toBe(true);

    const settled = draftReviewReducer(draftOnePending, {
      type: "discardSettled",
      draftId: "draft-1",
      operationId: "op-1",
    });

    expect(inlineDiscardIsPending(settled)).toBe(false);
    expect(discardCanStart(settled, "draft-1")).toBe(true);
  });

  it("blocks apply while a proposal discard is settling", () => {
    expect(acceptIsBlocked({ isPending: false, isInlineDiscardPending: true })).toBe(true);
    expect(acceptIsBlocked({ isPending: false, isInlineDiscardPending: false })).toBe(false);
  });
});
