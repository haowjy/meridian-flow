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
      message: { code: "change-cannot-place", tone: "info" },
    });
    const withSibling = draftReviewReducer(first, {
      type: "operationCannotPlace",
      draftId: "draft-1",
      operationId: "op-sibling",
      message: { code: "change-cannot-place", tone: "info" },
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
      message: { code: "change-cannot-place", tone: "info" },
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

  it("tracks per-operation discard pending state by draft", () => {
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

  it("settles successful operation discards when the refreshed model no longer contains them", () => {
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
      code: "discard-not-settled",
    });

    expect(inlineDiscardIsPending(timedOut, "draft-1")).toBe(false);
    expect(timedOut.inlineDiscardError).toBe("discard-not-settled");
  });

  it("ignores a second operation-accept start while one is already in flight", () => {
    const first = draftReviewReducer(INLINE_STATE, {
      type: "operationAcceptStarted",
      operationId: "op-1",
    });
    expect(first.acceptingOperationId).toBe("op-1");

    // A second card's Apply while op-1 is mid-mutation must not steal the lock —
    // the in-flight op keeps `acceptingOperationId` until it terminates.
    const second = draftReviewReducer(first, {
      type: "operationAcceptStarted",
      operationId: "op-2",
    });
    expect(second.acceptingOperationId).toBe("op-1");
    expect(second).toBe(first);
  });

  it("blocks apply while an operation discard is settling", () => {
    expect(acceptIsBlocked({ isPending: false, isInlineDiscardPending: true })).toBe(true);
    expect(acceptIsBlocked({ isPending: false, isInlineDiscardPending: false })).toBe(false);
  });

  it("blocks apply while a per-card operation accept is in flight", () => {
    expect(
      acceptIsBlocked({
        isPending: false,
        isInlineDiscardPending: false,
        isOperationAccepting: true,
      }),
    ).toBe(true);
  });

  it("blocks apply while the active draft is terminal cannot_place", () => {
    expect(
      acceptIsBlocked({
        isPending: false,
        isInlineDiscardPending: false,
        isCannotPlaceTerminal: true,
      }),
    ).toBe(true);
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
    expect(TERMINAL.cannotPlaceDraft).toEqual({
      documentId: "doc-1",
      draftId: "draft-1",
      identity: null,
    });
    expect(TERMINAL.inlineReviewMessage?.code).toBe("draft-cannot-place");
  });

  it("keeps terminal cannot_place state when re-entering the same inline draft", () => {
    const reenteredInline = draftReviewReducer(TERMINAL, {
      type: "enterInline",
      documentId: "doc-1",
      draftId: "draft-1",
    });
    expect(reenteredInline.cannotPlaceDraft).toEqual({
      documentId: "doc-1",
      draftId: "draft-1",
      identity: null,
    });
    expect(reenteredInline.inlineReviewMessage?.code).toBe("draft-cannot-place");
  });

  it("keeps terminal cannot_place state when the same preview identity becomes available", () => {
    const withPreview = draftReviewReducer(INLINE_STATE, {
      type: "inlineModelAvailable",
      documentId: "doc-1",
      draftId: "draft-1",
      identity: "draft-1:1:1",
    });
    const terminal = draftReviewReducer(withPreview, {
      type: "applySucceeded",
      documentId: "doc-1",
      draftId: "draft-1",
      response: { status: "cannot_place", draftId: "draft-1" },
    });

    const next = draftReviewReducer(terminal, {
      type: "inlineModelAvailable",
      documentId: "doc-1",
      draftId: "draft-1",
      identity: "draft-1:1:1",
    });

    expect(next.cannotPlaceDraft).toEqual({
      documentId: "doc-1",
      draftId: "draft-1",
      identity: "draft-1:1:1",
    });
  });

  it("clears terminal cannot_place state when a new preview identity becomes available", () => {
    const withPreview = draftReviewReducer(INLINE_STATE, {
      type: "inlineModelAvailable",
      documentId: "doc-1",
      draftId: "draft-1",
      identity: "draft-1:1:1",
    });
    const terminal = draftReviewReducer(withPreview, {
      type: "applySucceeded",
      documentId: "doc-1",
      draftId: "draft-1",
      response: { status: "cannot_place", draftId: "draft-1" },
    });

    const next = draftReviewReducer(terminal, {
      type: "inlineModelAvailable",
      documentId: "doc-1",
      draftId: "draft-1",
      identity: "draft-1:1:2",
    });

    expect(next.cannotPlaceDraft).toBeNull();
    expect(next.inlineReviewMessage).toBeNull();
  });

  it("clears stale cannot_place state when entering a different inline draft", () => {
    const reenteredInline = draftReviewReducer(TERMINAL, {
      type: "enterInline",
      documentId: "doc-1",
      draftId: "draft-2",
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
    expect(next.cannotPlaceDraft).toEqual({
      documentId: "doc-1",
      draftId: "draft-1",
      identity: null,
    });
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
