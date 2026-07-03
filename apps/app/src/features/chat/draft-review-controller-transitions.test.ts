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

  it("keeps closure confirmation rendering state until cancelled", () => {
    const confirming = draftReviewReducer(INLINE_STATE, {
      type: "confirmAcceptOperation",
      operationId: "op-closure",
    });

    expect(confirming.confirmingAcceptOperationId).toBe("op-closure");

    const cancelled = draftReviewReducer(confirming, { type: "cancelAcceptOperation" });
    expect(cancelled.confirmingAcceptOperationId).toBeNull();
    expect(inlineReviewFromState(cancelled)).toEqual({ documentId: "doc-1", draftId: "draft-1" });
  });

  it("surfaces operation undo errors without leaving review mode", () => {
    const next = draftReviewReducer(INLINE_STATE, {
      type: "operationUndoAcceptFailed",
      message: { text: "Undo failed. Nothing changed.", tone: "error" },
    });

    expect(next.inlineReviewMessage).toEqual({
      text: "Undo failed. Nothing changed.",
      tone: "error",
    });
    expect(inlineReviewFromState(next)).toEqual({ documentId: "doc-1", draftId: "draft-1" });
  });

  it("records stale retry discard failures as settling errors", () => {
    const pending = draftReviewReducer(INLINE_STATE, {
      type: "discardStarted",
      draftId: "draft-1",
      operationId: "op-stale",
    });

    const failed = draftReviewReducer(pending, {
      type: "discardFailed",
      draftId: "draft-1",
      operationId: "op-stale",
      message: "Couldn't discard — your latest edits are still syncing. Try again in a moment.",
    });

    expect(inlineDiscardIsPending(failed, "draft-1")).toBe(false);
    expect(failed.inlineDiscardError).toBe(
      "Couldn't discard — your latest edits are still syncing. Try again in a moment.",
    );
  });

  it("deduplicates hard fallback transitions by inline-model identity", () => {
    const first = draftReviewReducer(INLINE_STATE, {
      type: "inlineModelUnavailable",
      documentId: "doc-1",
      draftId: "draft-1",
      identity: "draft-1:1:2",
    });
    const second = draftReviewReducer(first, {
      type: "inlineModelUnavailable",
      documentId: "doc-1",
      draftId: "draft-1",
      identity: "draft-1:1:2",
    });

    expect(first.surface).toEqual({ kind: "panel", documentId: "doc-1", draftId: "draft-1" });
    expect(second).toBe(first);

    const reset = draftReviewReducer(second, {
      type: "inlineModelAvailable",
      identity: "draft-1:1:3",
    });
    expect(reset.hardFallbackIdentity).toBeNull();
  });

  it("blocks apply while a proposal discard is settling", () => {
    expect(acceptIsBlocked({ isPending: false, isInlineDiscardPending: true })).toBe(true);
    expect(acceptIsBlocked({ isPending: false, isInlineDiscardPending: false })).toBe(false);
  });
});
