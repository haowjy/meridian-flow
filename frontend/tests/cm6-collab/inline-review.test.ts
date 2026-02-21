/**
 * Tests for the inline review CM6 extension state management.
 *
 * These tests exercise the StateField logic (effects → state transitions)
 * without needing a real DOM — we create a minimal EditorState with the
 * field and dispatch effects through transactions.
 */

import { describe, expect, it } from "vitest";
import { EditorState, type StateEffect } from "@codemirror/state";
import {
  inlineReviewField,
  setReviewHunks,
  resolveHunk,
  setActiveHunk,
  clearReview,
  type InlineReviewState,
} from "@/core/cm6-collab/review/inline-review";
import type { ReviewHunk } from "@/core/cm6-collab/review/types";

// ============================================================================
// Helpers
// ============================================================================

function makeHunk(overrides: Partial<ReviewHunk> = {}): ReviewHunk {
  return {
    id: "chunk-1",
    proposalId: "proposal-1",
    baseStart: 0,
    baseEnd: 5,
    deletedText: "hello",
    insertedText: "world",
    status: "pending",
    ...overrides,
  };
}

function makeHunks(count: number): ReviewHunk[] {
  return Array.from({ length: count }, (_, i) =>
    makeHunk({
      id: `chunk-${i}`,
      baseStart: i * 10,
      baseEnd: i * 10 + 5,
      deletedText: `text-${i}`,
      insertedText: `new-${i}`,
    }),
  );
}

/** Create an EditorState with just the inline review field */
function createState(doc = "hello world test content"): EditorState {
  return EditorState.create({
    doc,
    extensions: [inlineReviewField],
  });
}

/** Read the inline review field from state */
function getReviewState(state: EditorState): InlineReviewState {
  return state.field(inlineReviewField);
}

/** Apply an effect and return the new EditorState */
function applyEffect(
  state: EditorState,
  ...effects: Array<StateEffect<unknown>>
): EditorState {
  return state.update({ effects }).state;
}

// ============================================================================
// Tests
// ============================================================================

describe("inline review state field", () => {
  it("starts with empty state", () => {
    const state = createState();
    const review = getReviewState(state);

    expect(review.hunks).toEqual([]);
    expect(review.resolutions.size).toBe(0);
    expect(review.activeHunkIndex).toBe(-1);
  });

  describe("setReviewHunks", () => {
    it("populates state with hunks", () => {
      const hunks = makeHunks(3);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));

      const review = getReviewState(state);
      expect(review.hunks).toHaveLength(3);
      expect(review.hunks[0]!.id).toBe("chunk-0");
      expect(review.hunks[2]!.id).toBe("chunk-2");
    });

    it("sets activeHunkIndex to 0 on initial load (no prior hunks)", () => {
      const hunks = makeHunks(2);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));

      expect(getReviewState(state).activeHunkIndex).toBe(0);
    });

    it("sets activeHunkIndex to -1 when hunks are empty", () => {
      let state = createState();
      state = applyEffect(state, setReviewHunks.of([]));

      expect(getReviewState(state).activeHunkIndex).toBe(-1);
    });

    it("preserves resolutions for hunks that still exist after re-sync", () => {
      const hunks = makeHunks(3);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));

      // Resolve chunk-0 and chunk-2
      state = applyEffect(
        state,
        resolveHunk.of({ hunkId: "chunk-0", status: "accepted" }),
      );
      state = applyEffect(
        state,
        resolveHunk.of({ hunkId: "chunk-2", status: "rejected" }),
      );
      expect(getReviewState(state).resolutions.size).toBe(2);

      // Re-sync with same hunks — resolutions should carry over
      state = applyEffect(state, setReviewHunks.of(makeHunks(3)));
      const review = getReviewState(state);
      expect(review.resolutions.size).toBe(2);
      expect(review.resolutions.get("chunk-0")).toBe("accepted");
      expect(review.resolutions.get("chunk-2")).toBe("rejected");
    });

    it("drops resolutions for hunks that no longer exist", () => {
      const hunks = makeHunks(3);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));

      // Resolve all three
      state = applyEffect(
        state,
        resolveHunk.of({ hunkId: "chunk-0", status: "accepted" }),
      );
      state = applyEffect(
        state,
        resolveHunk.of({ hunkId: "chunk-1", status: "rejected" }),
      );
      state = applyEffect(
        state,
        resolveHunk.of({ hunkId: "chunk-2", status: "accepted" }),
      );
      expect(getReviewState(state).resolutions.size).toBe(3);

      // Re-sync with only 2 hunks (chunk-0 and chunk-1, chunk-2 gone)
      const newHunks = makeHunks(2); // chunk-0, chunk-1
      state = applyEffect(state, setReviewHunks.of(newHunks));
      const review = getReviewState(state);
      expect(review.resolutions.size).toBe(2);
      expect(review.resolutions.has("chunk-0")).toBe(true);
      expect(review.resolutions.has("chunk-1")).toBe(true);
      expect(review.resolutions.has("chunk-2")).toBe(false);
    });

    it("preserves activeHunkIndex across re-sync when index is valid", () => {
      const hunks = makeHunks(5);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));
      state = applyEffect(state, setActiveHunk.of(3));
      expect(getReviewState(state).activeHunkIndex).toBe(3);

      // Re-sync with same hunks — index should be preserved
      state = applyEffect(state, setReviewHunks.of(makeHunks(5)));
      expect(getReviewState(state).activeHunkIndex).toBe(3);
    });

    it("clamps activeHunkIndex when re-synced list is shorter", () => {
      const hunks = makeHunks(5);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));
      state = applyEffect(state, setActiveHunk.of(4));
      expect(getReviewState(state).activeHunkIndex).toBe(4);

      // Re-sync with fewer hunks — index should clamp
      state = applyEffect(state, setReviewHunks.of(makeHunks(3)));
      expect(getReviewState(state).activeHunkIndex).toBe(2);
    });

    it("preserves idle (-1) activeHunkIndex after Escape then re-sync", () => {
      const hunks = makeHunks(3);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));

      // Escape → idle
      state = applyEffect(state, setActiveHunk.of(-1));
      expect(getReviewState(state).activeHunkIndex).toBe(-1);

      // Re-sync — should stay idle
      state = applyEffect(state, setReviewHunks.of(makeHunks(3)));
      expect(getReviewState(state).activeHunkIndex).toBe(-1);
    });

    it("resets all resolutions when entirely new hunks are loaded", () => {
      const hunks = makeHunks(2);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));
      state = applyEffect(
        state,
        resolveHunk.of({ hunkId: "chunk-0", status: "accepted" }),
      );
      expect(getReviewState(state).resolutions.size).toBe(1);

      // Load entirely different hunks — no IDs match
      const differentHunks = [
        makeHunk({ id: "new-0", baseStart: 50, baseEnd: 55 }),
        makeHunk({ id: "new-1", baseStart: 60, baseEnd: 65 }),
      ];
      state = applyEffect(state, setReviewHunks.of(differentHunks));
      expect(getReviewState(state).resolutions.size).toBe(0);
    });
  });

  describe("resolveHunk", () => {
    it("updates resolution map for accepted hunk", () => {
      const hunks = makeHunks(3);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));
      state = applyEffect(
        state,
        resolveHunk.of({ hunkId: "chunk-1", status: "accepted" }),
      );

      const review = getReviewState(state);
      expect(review.resolutions.get("chunk-1")).toBe("accepted");
      expect(review.resolutions.size).toBe(1);
    });

    it("updates resolution map for rejected hunk", () => {
      const hunks = makeHunks(2);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));
      state = applyEffect(
        state,
        resolveHunk.of({ hunkId: "chunk-0", status: "rejected" }),
      );

      expect(getReviewState(state).resolutions.get("chunk-0")).toBe("rejected");
    });

    it("can resolve multiple hunks", () => {
      const hunks = makeHunks(3);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));
      state = applyEffect(
        state,
        resolveHunk.of({ hunkId: "chunk-0", status: "accepted" }),
      );
      state = applyEffect(
        state,
        resolveHunk.of({ hunkId: "chunk-2", status: "rejected" }),
      );

      const review = getReviewState(state);
      expect(review.resolutions.size).toBe(2);
      expect(review.resolutions.get("chunk-0")).toBe("accepted");
      expect(review.resolutions.get("chunk-2")).toBe("rejected");
    });
  });

  describe("clearReview", () => {
    it("resets all state", () => {
      const hunks = makeHunks(3);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));
      state = applyEffect(
        state,
        resolveHunk.of({ hunkId: "chunk-0", status: "accepted" }),
      );
      state = applyEffect(state, setActiveHunk.of(2));

      // Verify state has data
      expect(getReviewState(state).hunks.length).toBe(3);
      expect(getReviewState(state).resolutions.size).toBe(1);

      // Clear
      state = applyEffect(state, clearReview.of(undefined));
      const review = getReviewState(state);
      expect(review.hunks).toEqual([]);
      expect(review.resolutions.size).toBe(0);
      expect(review.activeHunkIndex).toBe(-1);
    });
  });

  describe("setActiveHunk (navigation)", () => {
    it("updates activeHunkIndex", () => {
      const hunks = makeHunks(5);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));
      expect(getReviewState(state).activeHunkIndex).toBe(0);

      state = applyEffect(state, setActiveHunk.of(3));
      expect(getReviewState(state).activeHunkIndex).toBe(3);
    });

    it("can wrap to beginning (set index 0 after last)", () => {
      const hunks = makeHunks(3);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));
      state = applyEffect(state, setActiveHunk.of(2));
      expect(getReviewState(state).activeHunkIndex).toBe(2);

      // Wrap to 0
      state = applyEffect(state, setActiveHunk.of(0));
      expect(getReviewState(state).activeHunkIndex).toBe(0);
    });

    it("can set to -1 (no active hunk)", () => {
      const hunks = makeHunks(2);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));
      state = applyEffect(state, setActiveHunk.of(-1));
      expect(getReviewState(state).activeHunkIndex).toBe(-1);
    });
  });

  describe("resolved hunks excluded from pending", () => {
    it("resolved hunks are in resolutions map, not pending", () => {
      const hunks = makeHunks(4);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));

      // Resolve 2 of 4
      state = applyEffect(
        state,
        resolveHunk.of({ hunkId: "chunk-0", status: "accepted" }),
      );
      state = applyEffect(
        state,
        resolveHunk.of({ hunkId: "chunk-2", status: "rejected" }),
      );

      const review = getReviewState(state);
      const pending = review.hunks.filter((c) => !review.resolutions.has(c.id));
      expect(pending).toHaveLength(2);
      expect(pending[0]!.id).toBe("chunk-1");
      expect(pending[1]!.id).toBe("chunk-3");
    });
  });

  describe("Escape focus clear (Phase 1)", () => {
    it("setActiveHunk.of(-1) clears active focus from a focused hunk", () => {
      const hunks = makeHunks(3);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));

      // Initially active hunk is 0
      expect(getReviewState(state).activeHunkIndex).toBe(0);

      // Focus hunk 2
      state = applyEffect(state, setActiveHunk.of(2));
      expect(getReviewState(state).activeHunkIndex).toBe(2);

      // Escape clears focus (Escape handler dispatches setActiveHunk.of(-1))
      state = applyEffect(state, setActiveHunk.of(-1));
      expect(getReviewState(state).activeHunkIndex).toBe(-1);
    });

    it("focus transitions: idle → focused → idle via Escape", () => {
      const hunks = makeHunks(2);
      let state = createState();

      // Idle: no hunks loaded
      expect(getReviewState(state).activeHunkIndex).toBe(-1);

      // Load hunks → auto-focus first
      state = applyEffect(state, setReviewHunks.of(hunks));
      expect(getReviewState(state).activeHunkIndex).toBe(0);

      // Navigate to next
      state = applyEffect(state, setActiveHunk.of(1));
      expect(getReviewState(state).activeHunkIndex).toBe(1);

      // Escape → back to idle
      state = applyEffect(state, setActiveHunk.of(-1));
      expect(getReviewState(state).activeHunkIndex).toBe(-1);

      // Can re-focus after Escape
      state = applyEffect(state, setActiveHunk.of(0));
      expect(getReviewState(state).activeHunkIndex).toBe(0);
    });

    it("Escape on already-idle state does not change state", () => {
      const hunks = makeHunks(2);
      let state = createState();
      state = applyEffect(state, setReviewHunks.of(hunks));

      // Clear focus
      state = applyEffect(state, setActiveHunk.of(-1));
      const stateBefore = getReviewState(state);

      // Another clear — state should be identical reference
      state = applyEffect(state, setActiveHunk.of(-1));
      // activeHunkIndex is already -1, so value is unchanged
      expect(getReviewState(state).activeHunkIndex).toBe(-1);
      expect(getReviewState(state).hunks).toBe(stateBefore.hunks);
    });
  });
});
