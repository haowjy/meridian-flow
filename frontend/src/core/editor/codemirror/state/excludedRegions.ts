/**
 * Excluded Regions
 *
 * Shared utility for regions of the document where inline decorations
 * should be suppressed (e.g., diff hunks). Decouples decoration providers
 * from the diff view module — providers import this instead of diffView/.
 */

/** A region of the document where decorations should be suppressed. */
export interface ExcludedRegion {
  from: number;
  to: number;
}

/** Check if a range [from, to) overlaps any excluded region. */
export function overlapsExcludedRegion(
  regions: readonly ExcludedRegion[],
  from: number,
  to: number,
): boolean {
  for (const r of regions) {
    if (from < r.to && to > r.from) return true;
  }
  return false;
}
