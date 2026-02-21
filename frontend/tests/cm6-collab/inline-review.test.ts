/**
 * Tests for the inline review CM6 extension state management.
 *
 * These tests exercise the StateField logic (effects → state transitions)
 * without needing a real DOM — we create a minimal EditorState with the
 * field and dispatch effects through transactions.
 */

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  inlineReviewField,
  setReviewChunks,
  resolveChunk,
  setActiveChunk,
  clearReview,
  type InlineReviewState,
} from "@/core/cm6-collab/review/inline-review";
import type { ReviewChunk } from "@/core/cm6-collab/review/types";

// ============================================================================
// Helpers
// ============================================================================

function makeChunk(overrides: Partial<ReviewChunk> = {}): ReviewChunk {
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

function makeChunks(count: number): ReviewChunk[] {
  return Array.from({ length: count }, (_, i) =>
    makeChunk({
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
  ...effects: Parameters<typeof state.update>[0]["effects"][]
): EditorState {
  return state.update({ effects: effects.flat() }).state;
}

// ============================================================================
// Tests
// ============================================================================

describe("inline review state field", () => {
  it("starts with empty state", () => {
    const state = createState();
    const review = getReviewState(state);

    expect(review.chunks).toEqual([]);
    expect(review.resolutions.size).toBe(0);
    expect(review.activeChunkIndex).toBe(-1);
  });

  describe("setReviewChunks", () => {
    it("populates state with chunks", () => {
      const chunks = makeChunks(3);
      let state = createState();
      state = applyEffect(state, setReviewChunks.of(chunks));

      const review = getReviewState(state);
      expect(review.chunks).toHaveLength(3);
      expect(review.chunks[0]!.id).toBe("chunk-0");
      expect(review.chunks[2]!.id).toBe("chunk-2");
    });

    it("sets activeChunkIndex to 0 when chunks are present", () => {
      const chunks = makeChunks(2);
      let state = createState();
      state = applyEffect(state, setReviewChunks.of(chunks));

      expect(getReviewState(state).activeChunkIndex).toBe(0);
    });

    it("sets activeChunkIndex to -1 when chunks are empty", () => {
      let state = createState();
      state = applyEffect(state, setReviewChunks.of([]));

      expect(getReviewState(state).activeChunkIndex).toBe(-1);
    });

    it("resets resolutions when new chunks are loaded", () => {
      const chunks = makeChunks(2);
      let state = createState();
      state = applyEffect(state, setReviewChunks.of(chunks));
      state = applyEffect(
        state,
        resolveChunk.of({ chunkId: "chunk-0", status: "accepted" }),
      );
      expect(getReviewState(state).resolutions.size).toBe(1);

      // Load new chunks — resolutions should reset
      state = applyEffect(state, setReviewChunks.of(makeChunks(3)));
      expect(getReviewState(state).resolutions.size).toBe(0);
    });

  });

  describe("resolveChunk", () => {
    it("updates resolution map for accepted chunk", () => {
      const chunks = makeChunks(3);
      let state = createState();
      state = applyEffect(state, setReviewChunks.of(chunks));
      state = applyEffect(
        state,
        resolveChunk.of({ chunkId: "chunk-1", status: "accepted" }),
      );

      const review = getReviewState(state);
      expect(review.resolutions.get("chunk-1")).toBe("accepted");
      expect(review.resolutions.size).toBe(1);
    });

    it("updates resolution map for rejected chunk", () => {
      const chunks = makeChunks(2);
      let state = createState();
      state = applyEffect(state, setReviewChunks.of(chunks));
      state = applyEffect(
        state,
        resolveChunk.of({ chunkId: "chunk-0", status: "rejected" }),
      );

      expect(getReviewState(state).resolutions.get("chunk-0")).toBe(
        "rejected",
      );
    });

    it("can resolve multiple chunks", () => {
      const chunks = makeChunks(3);
      let state = createState();
      state = applyEffect(state, setReviewChunks.of(chunks));
      state = applyEffect(
        state,
        resolveChunk.of({ chunkId: "chunk-0", status: "accepted" }),
      );
      state = applyEffect(
        state,
        resolveChunk.of({ chunkId: "chunk-2", status: "rejected" }),
      );

      const review = getReviewState(state);
      expect(review.resolutions.size).toBe(2);
      expect(review.resolutions.get("chunk-0")).toBe("accepted");
      expect(review.resolutions.get("chunk-2")).toBe("rejected");
    });
  });

  describe("clearReview", () => {
    it("resets all state", () => {
      const chunks = makeChunks(3);
      let state = createState();
      state = applyEffect(state, setReviewChunks.of(chunks));
      state = applyEffect(
        state,
        resolveChunk.of({ chunkId: "chunk-0", status: "accepted" }),
      );
      state = applyEffect(state, setActiveChunk.of(2));

      // Verify state has data
      expect(getReviewState(state).chunks.length).toBe(3);
      expect(getReviewState(state).resolutions.size).toBe(1);

      // Clear
      state = applyEffect(state, clearReview.of(undefined));
      const review = getReviewState(state);
      expect(review.chunks).toEqual([]);
      expect(review.resolutions.size).toBe(0);
      expect(review.activeChunkIndex).toBe(-1);
    });
  });

  describe("setActiveChunk (navigation)", () => {
    it("updates activeChunkIndex", () => {
      const chunks = makeChunks(5);
      let state = createState();
      state = applyEffect(state, setReviewChunks.of(chunks));
      expect(getReviewState(state).activeChunkIndex).toBe(0);

      state = applyEffect(state, setActiveChunk.of(3));
      expect(getReviewState(state).activeChunkIndex).toBe(3);
    });

    it("can wrap to beginning (set index 0 after last)", () => {
      const chunks = makeChunks(3);
      let state = createState();
      state = applyEffect(state, setReviewChunks.of(chunks));
      state = applyEffect(state, setActiveChunk.of(2));
      expect(getReviewState(state).activeChunkIndex).toBe(2);

      // Wrap to 0
      state = applyEffect(state, setActiveChunk.of(0));
      expect(getReviewState(state).activeChunkIndex).toBe(0);
    });

    it("can set to -1 (no active chunk)", () => {
      const chunks = makeChunks(2);
      let state = createState();
      state = applyEffect(state, setReviewChunks.of(chunks));
      state = applyEffect(state, setActiveChunk.of(-1));
      expect(getReviewState(state).activeChunkIndex).toBe(-1);
    });
  });

  describe("resolved chunks excluded from pending", () => {
    it("resolved chunks are in resolutions map, not pending", () => {
      const chunks = makeChunks(4);
      let state = createState();
      state = applyEffect(state, setReviewChunks.of(chunks));

      // Resolve 2 of 4
      state = applyEffect(
        state,
        resolveChunk.of({ chunkId: "chunk-0", status: "accepted" }),
      );
      state = applyEffect(
        state,
        resolveChunk.of({ chunkId: "chunk-2", status: "rejected" }),
      );

      const review = getReviewState(state);
      const pending = review.chunks.filter(
        (c) => !review.resolutions.has(c.id),
      );
      expect(pending).toHaveLength(2);
      expect(pending[0]!.id).toBe("chunk-1");
      expect(pending[1]!.id).toBe("chunk-3");
    });
  });
});
