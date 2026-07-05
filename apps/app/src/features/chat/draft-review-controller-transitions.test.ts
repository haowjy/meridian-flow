import { describe, expect, it } from "vitest";

import {
  acceptIsBlocked,
  type DraftReviewState,
  draftReviewReducer,
  EMPTY_DRAFT_REVIEW_STATE,
  inlineReviewFromState,
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

  it("exits inline review after a whole-draft discard", () => {
    const next = draftReviewReducer(INLINE_STATE, { type: "rejectSucceeded", draftId: "draft-1" });

    expect(inlineReviewFromState(next)).toBeNull();
    expect(next.overlap).toBeNull();
  });

  it("clears inline review with one exit transition", () => {
    const next = draftReviewReducer(INLINE_STATE, { type: "exitReview" });

    expect(next.surface).toEqual({ kind: "none" });
    expect(next.overlap).toBeNull();
    expect(next.staleDraft).toBeNull();
  });

  it("blocks apply while a mutation is pending", () => {
    expect(acceptIsBlocked({ isPending: true })).toBe(true);
    expect(acceptIsBlocked({ isPending: false })).toBe(false);
  });

  it("blocks apply while the active draft is terminal cannot_place", () => {
    expect(
      acceptIsBlocked({
        isPending: false,
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

  it("keeps cannot_place inline", () => {
    expect(inlineReviewFromState(TERMINAL)).toEqual({ documentId: "doc-1", draftId: "draft-1" });
    expect(TERMINAL.cannotPlaceDraft).toEqual({
      documentId: "doc-1",
      draftId: "draft-1",
      identity: null,
    });
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
  });

  it("clears stale cannot_place state when entering a different inline draft", () => {
    const reenteredInline = draftReviewReducer(TERMINAL, {
      type: "enterInline",
      documentId: "doc-1",
      draftId: "draft-2",
    });
    expect(reenteredInline.cannotPlaceDraft).toBeNull();
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
