/**
 * Shared CM6 state for the inline review system.
 *
 * Extracted from inline-review.ts to break the circular dependency between
 * inline-review.ts and hover-manager.ts — both need access to the StateField
 * and effects.
 */

import { StateField, StateEffect } from "@codemirror/state";
import type { ReviewChunk } from "./types";

// ============================================================================
// TYPES
// ============================================================================

export interface InlineReviewState {
  chunks: ReviewChunk[];
  resolutions: Map<string, "accepted" | "rejected">;
  activeChunkIndex: number; // -1 = none
}

export interface InlineReviewCallbacks {
  onAcceptChunk: (chunk: ReviewChunk) => void;
  onRejectChunk: (chunk: ReviewChunk) => void;
}

// ============================================================================
// STATE EFFECTS
// ============================================================================

/** Load chunks for review */
export const setReviewChunks = StateEffect.define<ReviewChunk[]>();

/** Resolve a chunk (accept or reject) */
export const resolveChunk = StateEffect.define<{
  chunkId: string;
  status: "accepted" | "rejected";
}>();

/** Set active chunk index for navigation */
export const setActiveChunk = StateEffect.define<number>();

/** Clear all review state */
export const clearReview = StateEffect.define<void>();

// ============================================================================
// STATE FIELD
// ============================================================================

const emptyState: InlineReviewState = {
  chunks: [],
  resolutions: new Map(),
  activeChunkIndex: -1,
};

export const inlineReviewField = StateField.define<InlineReviewState>({
  create() {
    return emptyState;
  },

  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setReviewChunks)) {
        // Carry over existing resolutions for chunks that still exist.
        // This prevents the re-sync race (Bug 2): accepting a chunk changes
        // the Yjs doc → reviewRevision++ → setReviewChunks fires, and we
        // must not wipe the just-recorded resolution.
        const newIds = new Set(effect.value.map((c) => c.id));
        const carried = new Map<string, "accepted" | "rejected">();
        for (const [id, status] of value.resolutions) {
          if (newIds.has(id)) carried.set(id, status);
        }

        // Preserve current activeChunkIndex across re-syncs (#5).
        // If idle (-1), stay idle. Otherwise clamp to new list length.
        let nextIndex: number;
        if (effect.value.length === 0) {
          nextIndex = -1;
        } else if (value.activeChunkIndex < 0) {
          // Was idle — stay idle unless this is the initial load
          // (initial load = no prior chunks)
          nextIndex = value.chunks.length === 0 ? 0 : -1;
        } else {
          // Clamp to new bounds
          nextIndex = Math.min(value.activeChunkIndex, effect.value.length - 1);
        }

        return {
          chunks: effect.value,
          resolutions: carried,
          activeChunkIndex: nextIndex,
        };
      }
      if (effect.is(resolveChunk)) {
        const next = new Map(value.resolutions);
        next.set(effect.value.chunkId, effect.value.status);
        return { ...value, resolutions: next };
      }
      if (effect.is(setActiveChunk)) {
        return { ...value, activeChunkIndex: effect.value };
      }
      if (effect.is(clearReview)) {
        return emptyState;
      }
    }
    return value;
  },
});
