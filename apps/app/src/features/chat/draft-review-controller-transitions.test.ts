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
    expect(selectedDraftFromState(next)).toBeNull();
    expect(next.confirmingAcceptOperationId).toBe("op-2");
    expect(next.overlap).toEqual({
      draftId: "draft-1",
      operationId: "op-2",
      liveRevisionToken: 9,
      live: "live changed",
      preview: "merged preview",
    });
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
      message: {
        text: "This proposal can’t be placed automatically because the surrounding text changed too much. Discard this proposal or apply the whole draft.",
        tone: "error",
      },
    });

    expect(inlineReviewFromState(terminal)).toEqual({ documentId: "doc-1", draftId: "draft-1" });
    expect(terminal.confirmingAcceptOperationId).toBeNull();
    expect(terminal.overlap).toBeNull();
    expect(terminal.inlineReviewMessage).toEqual({
      text: "This proposal can’t be placed automatically because the surrounding text changed too much. Discard this proposal or apply the whole draft.",
      tone: "error",
    });
    expect([...cannotPlaceOperationIdsForDraft(terminal, "draft-1")]).toEqual(["op-2"]);
  });

  it("exits inline review after a whole-draft discard", () => {
    const next = draftReviewReducer(INLINE_STATE, { type: "rejectSucceeded", draftId: "draft-1" });

    expect(selectedDraftFromState(next)).toBeNull();
    expect(inlineReviewFromState(next)).toBeNull();
    expect(next.overlap).toBeNull();
  });

  it("clears only the discarded operation from terminal cannot-place state", () => {
    const first = draftReviewReducer(INLINE_STATE, {
      type: "operationCannotPlace",
      draftId: "draft-1",
      operationId: "op-dead",
      message: { text: "Cannot place", tone: "error" },
    });
    const withSibling = draftReviewReducer(first, {
      type: "operationCannotPlace",
      draftId: "draft-1",
      operationId: "op-sibling",
      message: { text: "Cannot place", tone: "error" },
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
    expect(inlineReviewFromState(discarding)).toEqual({ documentId: "doc-1", draftId: "draft-1" });
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

  it("settles successful proposal discards when the refreshed model no longer contains them", () => {
    const pending = draftReviewReducer(INLINE_STATE, {
      type: "discardStarted",
      draftId: "draft-1",
      operationId: "op-discarded",
    });

    expect(pendingDiscardIdsMissingFromModel(pending, "draft-1", ["op-still-present"])).toEqual([
      "op-discarded",
    ]);

    const settled = draftReviewReducer(pending, {
      type: "discardSettled",
      draftId: "draft-1",
      operationId: "op-discarded",
    });

    expect(inlineDiscardIsPending(settled, "draft-1")).toBe(false);
    expect(
      acceptIsBlocked({
        isPending: false,
        isInlineDiscardPending: inlineDiscardIsPending(settled),
      }),
    ).toBe(false);
    expect(settled.inlineDiscardError).toBeNull();
  });

  it("treats a fresh empty inline model as settling every pending discard for that draft", () => {
    const pendingFirst = draftReviewReducer(INLINE_STATE, {
      type: "discardStarted",
      draftId: "draft-1",
      operationId: "op-last",
    });
    const pendingSecond = draftReviewReducer(pendingFirst, {
      type: "discardStarted",
      draftId: "draft-2",
      operationId: "op-other-draft",
    });

    expect(pendingDiscardIdsMissingFromModel(pendingSecond, "draft-1", [])).toEqual(["op-last"]);

    const settled = draftReviewReducer(pendingSecond, {
      type: "discardSettled",
      draftId: "draft-1",
      operationId: "op-last",
    });

    expect(inlineDiscardIsPending(settled, "draft-1")).toBe(false);
    expect(inlineDiscardIsPending(settled, "draft-2")).toBe(true);
    expect(
      acceptIsBlocked({
        isPending: false,
        isInlineDiscardPending: inlineDiscardIsPending(settled, "draft-1"),
      }),
    ).toBe(false);
    expect(settled.inlineDiscardError).toBeNull();
  });

  it("does not settle transient inline-model unavailability by reducer fallback alone", () => {
    const pending = draftReviewReducer(INLINE_STATE, {
      type: "discardStarted",
      draftId: "draft-1",
      operationId: "op-pending",
    });

    const fallback = draftReviewReducer(pending, {
      type: "inlineModelUnavailable",
      documentId: "doc-1",
      draftId: "draft-1",
      identity: "draft-1:1:2",
    });

    expect(inlineDiscardIsPending(fallback, "draft-1")).toBe(true);
    expect(pendingDiscardIdsForDraft(fallback, "draft-1").has("op-pending")).toBe(true);
  });

  it("does not settle panel fallback previews without a trustworthy operation set", () => {
    const pending = draftReviewReducer(INLINE_STATE, {
      type: "discardStarted",
      draftId: "draft-1",
      operationId: "op-pending",
    });

    expect(
      pendingDiscardIdsSettledByPreview(pending, {
        documentId: "doc-1",
        draftId: "draft-1",
      }),
    ).toEqual([]);
  });

  it("settles a discarded last operation after panel fallback when the refreshed operation set is empty", () => {
    const pending = draftReviewReducer(INLINE_STATE, {
      type: "discardStarted",
      draftId: "draft-1",
      operationId: "op-last",
    });
    const fallback = draftReviewReducer(pending, {
      type: "inlineModelUnavailable",
      documentId: "doc-1",
      draftId: "draft-1",
      identity: "draft-1:1:2",
    });

    expect(
      pendingDiscardIdsSettledByPreview(fallback, {
        documentId: "doc-1",
        draftId: "draft-1",
        operationIds: [],
      }),
    ).toEqual(["op-last"]);
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

    const cancelled = draftReviewReducer(confirming, { type: "cancelAcceptOperation" });
    expect(cancelled.confirmingAcceptOperationId).toBeNull();
    expect(inlineReviewFromState(cancelled)).toEqual({ documentId: "doc-1", draftId: "draft-1" });
  });

  it("surfaces operation undo errors without leaving review mode", () => {
    const next = draftReviewReducer(INLINE_STATE, {
      type: "operationUndoAcceptFailed",
      message: { text: "Couldn't undo that proposal. Nothing changed.", tone: "error" },
    });

    expect(next.inlineReviewMessage).toEqual({
      text: "Couldn't undo that proposal. Nothing changed.",
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
