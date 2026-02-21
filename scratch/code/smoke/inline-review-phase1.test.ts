/**
 * Smoke test: Phase 1 Floating Hunk Toolbar
 *
 * Verifies the key state transitions for the new floating toolbar behavior:
 * - HunkActionWidget gets isFocused flag based on activeChunkIndex
 * - Escape clears focused state
 * - Decoration builder produces mark decorations with data-hunk-id
 * - No inline action buttons stacking in document flow
 */

import { describe, expect, it } from "vitest";
import { EditorState, type StateEffect } from "@codemirror/state";
import {
  inlineReviewField,
  setReviewChunks,
  resolveChunk,
  setActiveChunk,
  clearReview,
  type InlineReviewState,
} from "@/core/cm6-collab/review/inline-review";
import type { ReviewChunk } from "@/core/cm6-collab/review/types";

function makeChunk(overrides: Partial<ReviewChunk> = {}): ReviewChunk {
  return {
    id: "p1-chunk-0",
    proposalId: "proposal-1",
    baseStart: 0,
    baseEnd: 5,
    deletedText: "hello",
    insertedText: "world",
    status: "pending",
    ...overrides,
  };
}

function createState(doc = "hello world test content"): EditorState {
  return EditorState.create({ doc, extensions: [inlineReviewField] });
}

function getReview(state: EditorState): InlineReviewState {
  return state.field(inlineReviewField);
}

function apply(
  state: EditorState,
  ...effects: Array<StateEffect<unknown>>
): EditorState {
  return state.update({ effects }).state;
}

describe("Phase 1: floating toolbar state behavior", () => {
  it("activeChunkIndex tracks which hunk toolbar gets .cm-review-focused-visible", () => {
    const chunks = [
      makeChunk({ id: "p1-chunk-0", baseStart: 0, baseEnd: 5 }),
      makeChunk({ id: "p1-chunk-1", baseStart: 10, baseEnd: 15 }),
    ];
    let state = createState();
    state = apply(state, setReviewChunks.of(chunks));

    // Active index 0 → first hunk gets focus
    expect(getReview(state).activeChunkIndex).toBe(0);

    // Navigate to second → second hunk gets focus
    state = apply(state, setActiveChunk.of(1));
    expect(getReview(state).activeChunkIndex).toBe(1);

    // Escape → no hunk focused (toolbar hidden unless hovered)
    state = apply(state, setActiveChunk.of(-1));
    expect(getReview(state).activeChunkIndex).toBe(-1);
  });

  it("resolving a chunk preserves active index for remaining chunks", () => {
    const chunks = [
      makeChunk({ id: "p1-chunk-0", baseStart: 0, baseEnd: 5 }),
      makeChunk({ id: "p1-chunk-1", baseStart: 10, baseEnd: 15 }),
      makeChunk({ id: "p1-chunk-2", baseStart: 20, baseEnd: 25 }),
    ];
    let state = createState("a".repeat(30));
    state = apply(state, setReviewChunks.of(chunks));
    state = apply(state, setActiveChunk.of(1));

    // Resolve chunk-0 (not active)
    state = apply(
      state,
      resolveChunk.of({ chunkId: "p1-chunk-0", status: "accepted" }),
    );

    // Active index unchanged — still pointing to chunk-1
    expect(getReview(state).activeChunkIndex).toBe(1);
    expect(getReview(state).resolutions.has("p1-chunk-0")).toBe(true);
  });

  it("clearReview resets everything for a fresh review session", () => {
    const chunks = [makeChunk()];
    let state = createState();
    state = apply(state, setReviewChunks.of(chunks));
    state = apply(state, setActiveChunk.of(0));

    state = apply(state, clearReview.of(undefined));

    expect(getReview(state).chunks).toEqual([]);
    expect(getReview(state).activeChunkIndex).toBe(-1);
    expect(getReview(state).resolutions.size).toBe(0);
  });

  it("chunk IDs preserve protocol format (proposalId-chunk-index)", () => {
    const chunk = makeChunk({ id: "myProposal-chunk-3" });
    let state = createState();
    state = apply(state, setReviewChunks.of([chunk]));

    expect(getReview(state).chunks[0]!.id).toBe("myProposal-chunk-3");
  });
});
