import { describe, expect, it } from "vitest";

import {
  acceptIsBlocked,
  type DraftReviewSurfaceState,
  stateAfterAcceptResult,
  stateAfterRejectSuccess,
} from "./draft-review-controller-transitions";

const INLINE_STATE: DraftReviewSurfaceState = {
  selectedDraft: null,
  inlineReview: { documentId: "doc-1", draftId: "draft-1" },
  overlap: null,
};

describe("draft review controller transitions", () => {
  it("exits inline review after a successful apply", () => {
    const next = stateAfterAcceptResult(INLINE_STATE, {
      documentId: "doc-1",
      draftId: "draft-1",
      response: {
        status: "applied",
        draftId: "draft-1",
        appliedUpdateSeq: 12,
        acceptTurnId: "turn-1",
      },
    });

    expect(next).toEqual({ selectedDraft: null, inlineReview: null, overlap: null });
  });

  it("moves inline overlap responses into panel confirmation state", () => {
    const next = stateAfterAcceptResult(INLINE_STATE, {
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

    expect(next).toEqual({
      selectedDraft: { documentId: "doc-1", draftId: "draft-1" },
      inlineReview: null,
      overlap: {
        draftId: "draft-1",
        liveRevisionToken: 9,
        live: "live changed",
        preview: "merged preview",
      },
    });
  });

  it("exits inline review after a whole-draft discard", () => {
    const next = stateAfterRejectSuccess(INLINE_STATE, "draft-1");

    expect(next).toEqual({ selectedDraft: null, inlineReview: null, overlap: null });
  });

  it("blocks apply while a proposal discard is settling", () => {
    expect(acceptIsBlocked({ isPending: false, isInlineDiscardPending: true })).toBe(true);
    expect(acceptIsBlocked({ isPending: false, isInlineDiscardPending: false })).toBe(false);
  });
});
