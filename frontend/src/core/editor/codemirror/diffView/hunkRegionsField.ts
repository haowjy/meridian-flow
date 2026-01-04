/**
 * Hunk Regions StateField
 *
 * SRP: Provides hunk boundary positions to any plugin that needs them.
 * Used by live preview to skip decoration inside diff regions.
 */

import { StateField } from '@codemirror/state'
import { extractHunks, hasAnyMarker } from '@/core/lib/mergedDocument'

// =============================================================================
// TYPES
// =============================================================================

export interface HunkRegion {
  /** Start of hunk (DEL_START marker position) */
  from: number
  /** End of hunk (after INS_END marker) */
  to: number
}

// =============================================================================
// STATE FIELD
// =============================================================================

/**
 * StateField that tracks hunk region positions.
 *
 * Recomputes on document change. Returns empty array if no markers present.
 */
export const hunkRegionsField = StateField.define<HunkRegion[]>({
  create(state) {
    const doc = state.doc.toString()
    if (!hasAnyMarker(doc)) return []
    return extractHunks(doc).map(h => ({ from: h.from, to: h.to }))
  },
  update(value, tr) {
    if (!tr.docChanged) return value
    const doc = tr.state.doc.toString()
    if (!hasAnyMarker(doc)) return []
    return extractHunks(doc).map(h => ({ from: h.from, to: h.to }))
  },
})

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Check if a range overlaps any hunk region.
 *
 * Uses standard interval overlap: [a, b) overlaps [c, d) if a < d && b > c
 */
export function overlapsHunkRegion(
  regions: HunkRegion[],
  from: number,
  to: number
): boolean {
  for (const region of regions) {
    if (from < region.to && to > region.from) {
      return true
    }
  }
  return false
}
