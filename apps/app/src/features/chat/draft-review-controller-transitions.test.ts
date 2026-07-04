import { describe, expect, it } from "vitest";

import {
  acceptIsBlocked,
  cannotPlaceOperationIdsForDraft,
  type DraftReviewState,
  discardCanStart,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  inlineDiscardIsPending,
  inlineReviewFromState,
  pendingDiscardIdsForDraft,
  pendingDiscardIdsMissingFromModel,
  pendingDiscardIdsSettledByPreview,
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
      response: { status: "applied", draftId: "draft-1" },
    });

    expect(inlineReviewFromState(next)).toBeNull();
    expect(next.overlap).toBeNull();
  });

  it("keeps whole-draft overlap confirmation in inline review", () => {
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

    expect(inlineReviewFromState(next)).toEqual({ documentId: "doc-1", draftId: "draft-1" });
    expect(next.overlap).toEqual({
      draftId: "draft-1",
      liveRevisionToken: 9,
      live: "live changed",
      preview: "merged preview",
    });
  });

  it("keeps per-operation overlap confirmation in inline review", () => {
    const next = draftReviewReducer(INLINE_STATE, {
      type: "operationOverlapReturned",
      documentId: "doc-1",
      overlap: {
        draftId: "draft-1",
        operationId: "op-2",
        liveRevisionToken: 9,
        live: "live changed",
        preview: "merged preview",
      },
    });

    expect(inlineReviewFromState(next)).toEqual({ documentId: "doc-1", draftId: "draft-1" });
    expect(next.confirmingAcceptOperationId).toBe("op-2");
    expect(next.overlap).toMatchObject({ draftId: "draft-1", operationId: "op-2" });
  });

  it("cancels per-operation overlap confirmation without closing inline review", () => {
    const confirming = draftReviewReducer(INLINE_STATE, {
      type: "operationOverlapReturned",
      documentId: "doc-1",
      overlap: { draftId: "draft-1", operationId: "op-2", liveRevisionToken: 9 },
    });

    const cancelled = draftReviewReducer(confirming, { type: "cancelAcceptOperation" });

    expect(inlineReviewFromState(cancelled)).toEqual({ documentId: "doc-1", draftId: "draft-1" });
    expect(cancelled.confirmingAcceptOperationId).toBeNull();
    expect(cancelled.overlap).toBeNull();
  });

  it("exits per-operation confirm state when terminal cannot-place messaging is shown", () => {
    const confirming = draftReviewReducer(INLINE_STATE, {
      type: "operationOverlapReturned",
      documentId: "doc-1",
      overlap: { draftId: "draft-1", operationId: "op-2", liveRevisionToken: 9 },
    });
    const started = draftReviewReducer(confirming, { type: "operationAcceptStarted" });
    const terminal = draftReviewReducer(started, {
      type: "operationCannotPlace",
      draftId: "draft-1",
      operationId: "op-2",
      message: { text: "A proposal no longer lines up with the manuscript.", tone: "info" },
    });

    expect(inlineReviewFromState(terminal)).toEqual({ documentId: "doc-1", draftId: "draft-1" });
    expect(terminal.confirmingAcceptOperationId).toBeNull();
    expect(terminal.overlap).toBeNull();
    expect([...cannotPlaceOperationIdsForDraft(terminal, "draft-1")]).toEqual(["op-2"]);
  });

  it("exits inline review after a whole-draft discard", () => {
    const next = draftReviewReducer(INLINE_STATE, { type: "rejectSucceeded", draftId: "draft-1" });

    expect(inlineReviewFromState(next)).toBeNull();
    expect(next.overlap).toBeNull();
  });

  it("clears only the discarded operation from terminal cannot-place state", () => {
    const first = draftReviewReducer(INLINE_STATE, {
      type: "operationCannotPlace",
      draftId: "draft-1",
      operationId: "op-dead",
      message: { text: "Cannot place", tone: "info" },
    });
    const withSibling = draftReviewReducer(first, {
      type: "operationCannotPlace",
      draftId: "draft-1",
      operationId: "op-sibling",
      message: { text: "Cannot place", tone: "info" },
    });

    const started = draftReviewReducer(withSibling, {
      type: "discardStarted",
      draftId: "draft-1",
      operationId: "op-dead",
    });
    const discarding = draftReviewReducer(started, {
      type: "discardSettled",
      draftId: "draft-1",
      operationId: "op-dead",
    });

    expect([...cannotPlaceOperationIdsForDraft(discarding, "draft-1")]).toEqual(["op-sibling"]);
  });

  it("clears inline review with one exit transition", () => {
    const next = draftReviewReducer(INLINE_STATE, { type: "exitReview" });

    expect(next.surface).toEqual({ kind: "none" });
    expect(next.overlap).toBeNull();
    expect(next.staleDraft).toBeNull();
  });

  it("keeps terminal cannot-place cards across inline and review transitions", () => {
    const terminal = draftReviewReducer(INLINE_STATE, {
      type: "operationCannotPlace",
      draftId: "draft-1",
      operationId: "op-dead",
      message: { text: "Cannot place", tone: "info" },
    });

    const exitedInline = draftReviewReducer(terminal, { type: "exitInline" });
    expect([...cannotPlaceOperationIdsForDraft(exitedInline, "draft-1")]).toEqual(["op-dead"]);

    const reentered = draftReviewReducer(exitedInline, {
      type: "enterInline",
      documentId: "doc-1",
      draftId: "draft-1",
    });
    expect([...cannotPlaceOperationIdsForDraft(reentered, "draft-1")]).toEqual(["op-dead"]);
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
  });

  it("settles successful proposal discards when the refreshed model no longer contains them", () => {
    const pending = draftReviewReducer(INLINE_STATE, {
      type: "discardStarted",
      draftId: "draft-1",
      operationId: "op-discarded",
    });

    expect(pendingDiscardIdsMissingFromModel(pending, "draft-1", ["op-still-present"])).toEqual([
      "op-discarded",
    ]);
    expect(
      pendingDiscardIdsSettledByPreview(pending, {
        documentId: "doc-1",
        draftId: "draft-1",
        operationIds: ["op-still-present"],
      }),
    ).toEqual(["op-discarded"]);
  });

  it("does not settle previews without a trustworthy operation set", () => {
    const pending = draftReviewReducer(INLINE_STATE, {
      type: "discardStarted",
      draftId: "draft-1",
      operationId: "op-pending",
    });

    expect(
      pendingDiscardIdsSettledByPreview(pending, { documentId: "doc-1", draftId: "draft-1" }),
    ).toEqual([]);
  });

  it("settles discards only for the same document and draft preview", () => {
    const pending = draftReviewReducer(INLINE_STATE, {
      type: "discardStarted",
      draftId: "draft-1",
      operationId: "op-pending",
    });

    expect(
      pendingDiscardIdsSettledByPreview(pending, {
        documentId: "doc-2",
        draftId: "draft-1",
        operationIds: [],
      }),
    ).toEqual([]);
  });

  it("keeps pending discard state for the timeout backstop while the operation remains in the model", () => {
    const pending = draftReviewReducer(INLINE_STATE, {
      type: "discardStarted",
      draftId: "draft-1",
      operationId: "op-still-present",
    });

    expect(pendingDiscardIdsMissingFromModel(pending, "draft-1", ["op-still-present"])).toEqual([]);

    const timedOut = draftReviewReducer(pending, {
      type: "discardFailed",
      draftId: "draft-1",
      operationId: "op-still-present",
      message: "That change is still in the draft. Try again before applying the draft.",
    });

    expect(inlineDiscardIsPending(timedOut, "draft-1")).toBe(false);
    expect(timedOut.inlineDiscardError).toBe(
      "That change is still in the draft. Try again before applying the draft.",
    );
  });

  it("keeps closure confirmation rendering state until cancelled", () => {
    const confirming = draftReviewReducer(INLINE_STATE, {
      type: "confirmAcceptOperation",
      operationId: "op-closure",
    });

    expect(confirming.confirmingAcceptOperationId).toBe("op-closure");
    expect(
      draftReviewReducer(confirming, { type: "cancelAcceptOperation" }).confirmingAcceptOperationId,
    ).toBeNull();
  });

  it("blocks apply while a proposal discard is settling", () => {
    expect(acceptIsBlocked({ isPending: false, isInlineDiscardPending: true })).toBe(true);
    expect(acceptIsBlocked({ isPending: false, isInlineDiscardPending: false })).toBe(false);
  });
});

describe("whole-draft cannot_place terminal state", () => {
  const TERMINAL = draftReviewReducer(INLINE_STATE, {
    type: "applySucceeded",
    documentId: "doc-1",
    draftId: "draft-1",
    response: { status: "cannot_place", draftId: "draft-1" },
  });

  it("keeps cannot_place inline and shows a terminal message", () => {
    expect(inlineReviewFromState(TERMINAL)).toEqual({ documentId: "doc-1", draftId: "draft-1" });
    expect(TERMINAL.cannotPlaceDraft).toEqual({ documentId: "doc-1", draftId: "draft-1" });
    expect(TERMINAL.inlineReviewMessage?.text).toContain("no longer lines up");
  });

  it("clears stale cannot_place state when entering inline review", () => {
    const reenteredInline = draftReviewReducer(TERMINAL, {
      type: "enterInline",
      documentId: "doc-1",
      draftId: "draft-1",
    });
    expect(reenteredInline.cannotPlaceDraft).toBeNull();
    expect(reenteredInline.inlineReviewMessage).toBeNull();
  });

  it("clears the terminal state when the draft is discarded", () => {
    const next = draftReviewReducer(TERMINAL, { type: "rejectSucceeded", draftId: "draft-1" });
    expect(next.cannotPlaceDraft).toBeNull();
    expect(inlineReviewFromState(next)).toBeNull();
  });

  it("keeps another draft's terminal state when an unrelated draft is discarded", () => {
    const next = draftReviewReducer(TERMINAL, { type: "rejectSucceeded", draftId: "draft-2" });
    expect(next.cannotPlaceDraft).toEqual({ documentId: "doc-1", draftId: "draft-1" });
  });

  it("replaces the terminal state with staleDraft when a later accept reports stale", () => {
    const next = draftReviewReducer(TERMINAL, {
      type: "applySucceeded",
      documentId: "doc-1",
      draftId: "draft-1",
      response: { status: "stale_draft", draftId: "draft-1", draftRevisionToken: 4 },
    });
    expect(next.cannotPlaceDraft).toBeNull();
    expect(next.staleDraft).toEqual({ documentId: "doc-1", draftId: "draft-1" });
  });
});
