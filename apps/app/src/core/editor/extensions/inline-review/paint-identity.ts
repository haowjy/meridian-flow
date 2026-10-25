/** Disposable hunk identity for painting only. Commands always use the text-derived review. */
import type { ReviewHunk } from "@meridian/agent-edit/diff";
import type { ProjectedReview } from "./model";

interface Candidate {
  hunk: ReviewHunk;
  key: string;
  ordinal: number;
}

/** Match only one-to-one overlaps in the same mapped block; never guess across splits or merges. */
export function matchRenderKeys(
  previous: ProjectedReview | null,
  keys: ReadonlyMap<number, string>,
  next: ProjectedReview,
  mint: () => string,
): ReadonlyMap<number, string> {
  const buckets = (review: ProjectedReview, old: boolean) => {
    const blocks = new Map<number, Candidate[]>();
    for (const group of review.groups) {
      for (const hunk of group.hunks) {
        const pos = review.doc.resolve(hunk.anchor);
        const block = pos.depth ? pos.before(1) : hunk.anchor;
        const entries = blocks.get(block) ?? [];
        entries.push({
          hunk,
          key: old ? (keys.get(hunk.index) ?? "") : "",
          ordinal: entries.length,
        });
        blocks.set(block, entries);
      }
    }
    return blocks;
  };
  const oldBlocks = previous ? buckets(previous, true) : new Map<number, Candidate[]>();
  const result = new Map<number, string>();
  for (const [block, entries] of buckets(next, false)) {
    const old = oldBlocks.get(block) ?? [];
    const start = ({ hunk }: Candidate) => hunk.inserted?.from ?? hunk.anchor;
    const end = ({ hunk }: Candidate) => hunk.inserted?.to ?? hunk.anchor;
    // Hunk ranges do not cross; monotonic transaction mappings preserve that order,
    // including collapsed deletion anchors. Bound the candidate interval, not every old hunk.
    const ordered = [...old].sort((a, b) => start(a) - start(b) || end(a) - end(b));
    const bound = (value: number, read: (candidate: Candidate) => number, inclusive: boolean) => {
      let lo = 0;
      let hi = ordered.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (read(ordered[mid]) < value || (inclusive && read(ordered[mid]) === value)) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    const matches = entries.map((entry) => {
      const { hunk, ordinal } = entry;
      const lo = bound(start(entry), end, false);
      const hi = bound(end(entry), start, true);
      if (hi - lo === 1) return ordered[lo].hunk.kind === hunk.kind ? ordered[lo] : undefined;
      if (hi <= lo) return undefined;
      // Coincident deletion anchors need both their ordinal and unchanged removed content.
      const candidate = old[ordinal];
      return candidate &&
        candidate.hunk.kind === hunk.kind &&
        candidate.hunk.anchor === hunk.anchor &&
        start(candidate) <= end(entry) &&
        end(candidate) >= start(entry) &&
        JSON.stringify(candidate.hunk.removed) === JSON.stringify(hunk.removed)
        ? candidate
        : undefined;
    });
    const counts = new Map<Candidate, number>();
    for (const candidate of matches)
      if (candidate) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
    entries.forEach(({ hunk }, i) => {
      const candidate = matches[i];
      result.set(
        hunk.index,
        candidate?.key && counts.get(candidate) === 1 ? candidate.key : mint(),
      );
    });
  }
  return result;
}
