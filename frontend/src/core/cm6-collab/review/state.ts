/**
 * Shared CM6 state for the inline review system.
 *
 * Extracted from inline-review.ts to break the circular dependency between
 * inline-review.ts and hover-manager.ts — both need access to the StateField
 * and effects.
 */

import { StateField, StateEffect } from "@codemirror/state";
import type { ReviewHunk } from "./types";

// ============================================================================
// TYPES
// ============================================================================

export interface InlineReviewState {
  hunks: ReviewHunk[];
  resolutions: Map<string, "accepted" | "rejected">;
  activeHunkIndex: number; // -1 = none
}

export interface InlineReviewCallbacks {
  onAcceptHunk: (hunk: ReviewHunk) => void;
  onRejectHunk: (hunk: ReviewHunk) => void;
  onEditHunk: (hunk: ReviewHunk) => void;
}

// ============================================================================
// STATE EFFECTS
// ============================================================================

/** Load hunks for review */
export const setReviewHunks = StateEffect.define<ReviewHunk[]>();

/** Resolve a hunk (accept or reject) */
export const resolveHunk = StateEffect.define<{
  hunkId: string;
  status: "accepted" | "rejected";
}>();

/** Set active hunk index for navigation */
export const setActiveHunk = StateEffect.define<number>();

/** Clear all review state */
export const clearReview = StateEffect.define<void>();

// ============================================================================
// STATE FIELD
// ============================================================================

const emptyState: InlineReviewState = {
  hunks: [],
  resolutions: new Map(),
  activeHunkIndex: -1,
};

export const inlineReviewField = StateField.define<InlineReviewState>({
  create() {
    return emptyState;
  },

  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setReviewHunks)) {
        // Carry over existing resolutions for hunks that still exist.
        // This prevents the re-sync race (Bug 2): accepting a hunk changes
        // the Yjs doc → reviewRevision++ → setReviewHunks fires, and we
        // must not wipe the just-recorded resolution.
        const newIds = new Set(effect.value.map((c) => c.id));
        const carried = new Map<string, "accepted" | "rejected">();
        for (const [id, status] of value.resolutions) {
          if (newIds.has(id)) carried.set(id, status);
        }

        // Preserve current activeHunkIndex across re-syncs (#5).
        // If idle (-1), stay idle. Otherwise clamp to new list length.
        let nextIndex: number;
        if (effect.value.length === 0) {
          nextIndex = -1;
        } else if (value.activeHunkIndex < 0) {
          // Was idle — stay idle unless this is the initial load
          // (initial load = no prior hunks)
          nextIndex = value.hunks.length === 0 ? 0 : -1;
        } else {
          // Clamp to new bounds
          nextIndex = Math.min(value.activeHunkIndex, effect.value.length - 1);
        }

        return {
          hunks: effect.value,
          resolutions: carried,
          activeHunkIndex: nextIndex,
        };
      }
      if (effect.is(resolveHunk)) {
        const next = new Map(value.resolutions);
        next.set(effect.value.hunkId, effect.value.status);
        return { ...value, resolutions: next };
      }
      if (effect.is(setActiveHunk)) {
        return { ...value, activeHunkIndex: effect.value };
      }
      if (effect.is(clearReview)) {
        return emptyState;
      }
    }
    return value;
  },
});
