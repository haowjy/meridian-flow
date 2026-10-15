// Bounded weighted ordered matching shared by block alignment and echo attribution.

/**
 * The in-order pairs with the largest total weight (weight 0 never pairs).
 * Weights are nonnegative integers; ties prefer a match, then skipping old.
 * With 0/1 weights this is the longest common subsequence. Returns null when
 * the table exceeds the caller's limit, leaving fallback policy with the caller.
 */
export function weightedOrderedMatches(
  weight: (oldIndex: number, newIndex: number) => number,
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
  maxTableCells: number,
): Array<readonly [number, number]> | null {
  const rows = oldEnd - oldStart;
  const columns = newEnd - newStart;
  if (rows === 0 || columns === 0) return [];
  if ((rows + 1) * (columns + 1) > maxTableCells) return null;

  const width = columns + 1;
  const best = new Uint32Array((rows + 1) * width);
  const weights = new Uint32Array(rows * columns);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      const pair = weight(oldStart + row, newStart + column);
      weights[row * columns + column] = pair;
      const skip = Math.max(best[(row + 1) * width + column], best[row * width + column + 1]);
      best[row * width + column] =
        pair > 0 ? Math.max(skip, pair + best[(row + 1) * width + column + 1]) : skip;
    }
  }

  const matches: Array<readonly [number, number]> = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    const pair = weights[row * columns + column];
    if (pair > 0 && best[row * width + column] === pair + best[(row + 1) * width + column + 1]) {
      matches.push([oldStart + row, newStart + column]);
      row += 1;
      column += 1;
    } else if (best[(row + 1) * width + column] >= best[row * width + column + 1]) {
      row += 1;
    } else {
      column += 1;
    }
  }
  return matches;
}

/** Most table cells an equality match may allocate (one cell is four bytes, twice over). */
export const MAX_EQUAL_MATCH_CELLS = 250_000;

/**
 * The in-order pairs of equal keys, `[indexInA, indexInB]`, ascending in both. Ties follow
 * `weightedOrderedMatches` (prefer a match, then skip `a`), so with unmatched runs between pairs the
 * `a` side's run comes first. Memory is bounded: keys absent from the other side can never match, so
 * they are dropped first; if the rest still exceeds `MAX_EQUAL_MATCH_CELLS`, only keys occurring once on
 * each side are paired (longest increasing run). That fallback matches fewer pairs, never a wrong
 * one: callers keep everything unmatched.
 */
export function equalOrderedMatches(
  a: readonly string[],
  b: readonly string[],
): Array<readonly [number, number]> {
  const inB = new Set(b);
  const inA = new Set(a);
  const ai: number[] = [];
  const bi: number[] = [];
  for (let i = 0; i < a.length; i++) if (inB.has(a[i])) ai.push(i);
  for (let j = 0; j < b.length; j++) if (inA.has(b[j])) bi.push(j);
  const exact = weightedOrderedMatches(
    (i, j) => (a[ai[i]] === b[bi[j]] ? 1 : 0),
    0,
    ai.length,
    0,
    bi.length,
    MAX_EQUAL_MATCH_CELLS,
  );
  if (exact) return exact.map(([i, j]) => [ai[i], bi[j]] as const);

  const count = (keys: readonly string[], at: number[]) => {
    const seen = new Map<string, number>();
    for (const i of at) seen.set(keys[i], (seen.get(keys[i]) ?? 0) + 1);
    return seen;
  };
  const countA = count(a, ai);
  const countB = count(b, bi);
  const positionInB = new Map<string, number>();
  for (const j of bi) if (countB.get(b[j]) === 1) positionInB.set(b[j], j);
  const candidates: Array<readonly [number, number]> = [];
  for (const i of ai) {
    const j = countA.get(a[i]) === 1 ? positionInB.get(a[i]) : undefined;
    if (j !== undefined) candidates.push([i, j]);
  }
  // Longest increasing subsequence of the B positions (patience sorting).
  const tails: number[] = [];
  const previous: number[] = [];
  for (let c = 0; c < candidates.length; c++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (candidates[tails[mid]][1] < candidates[c][1]) lo = mid + 1;
      else hi = mid;
    }
    previous[c] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = c;
  }
  const out: Array<readonly [number, number]> = [];
  for (let c = tails.length ? tails[tails.length - 1] : -1; c >= 0; c = previous[c])
    out.push(candidates[c]);
  return out.reverse();
}
