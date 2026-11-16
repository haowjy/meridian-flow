import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";

/**
 * Myers' greedy diff of two key sequences as `[op, count]` runs, exact while the edit distance
 * stays within `maxEdits`. Its cost is bounded by that distance, not by how dissimilar the inputs
 * are, so a long paragraph with a few edits diffs exactly while a rewrite ends as one delete and
 * one insert of what the two share at neither end (coarser, never wrong).
 */
export function boundedDiff(
  a: readonly string[],
  b: readonly string[],
  maxEdits: number,
): Array<[number, number]> {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hi = 0;
  while (hi < a.length - lo && hi < b.length - lo && a[a.length - 1 - hi] === b[b.length - 1 - hi])
    hi++;
  const n = a.length - lo - hi;
  const m = b.length - lo - hi;
  const middle = myers(a, b, lo, n, m, maxEdits) ?? [
    [DIFF_DELETE, n],
    [DIFF_INSERT, m],
  ];
  const out: Array<[number, number]> = [];
  const push = (op: number, count: number) => {
    if (count <= 0) return;
    const last = out.at(-1);
    if (last && last[0] === op) last[1] += count;
    else out.push([op, count]);
  };
  push(DIFF_EQUAL, lo);
  for (const [op, count] of middle) push(op, count);
  push(DIFF_EQUAL, hi);
  return out;
}

function myers(
  a: readonly string[],
  b: readonly string[],
  at: number,
  n: number,
  m: number,
  maxEdits: number,
): Array<[number, number]> | null {
  if (n === 0 || m === 0)
    return [
      [DIFF_DELETE, n],
      [DIFF_INSERT, m],
    ];
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  const advances = (k: number, d: number) =>
    k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = advances(k, d) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[at + x] === b[at + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, offset, n, m, d);
    }
  }
  return null;
}

/** The runs of the shortest edit script, read back from each round's saved diagonals. */
function backtrack(
  trace: readonly Int32Array[],
  offset: number,
  n: number,
  m: number,
  rounds: number,
): Array<[number, number]> {
  const ops: number[] = [];
  let x = n;
  let y = m;
  for (let d = rounds; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const fromInsert = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]);
    const prevK = fromInsert ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : v[offset + prevK];
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(DIFF_EQUAL);
      x--;
      y--;
    }
    if (d > 0) {
      ops.push(x === prevX ? DIFF_INSERT : DIFF_DELETE);
      x = prevX;
      y = prevY;
    }
  }
  const runs: Array<[number, number]> = [];
  for (let i = ops.length - 1; i >= 0; i--) {
    const last = runs.at(-1);
    if (last && last[0] === ops[i]) last[1]++;
    else runs.push([ops[i], 1]);
  }
  return runs;
}
