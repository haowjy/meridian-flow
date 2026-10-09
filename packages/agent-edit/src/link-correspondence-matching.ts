// Lexicographic assignment and globally coupled document-order completion for link correspondence.

type Score = readonly [number, number, number, number, number];
export interface Candidate {
  occurrence: number;
  score: Score;
}
export interface MatchingResult {
  occurrences: number[];
  /** False only when the deterministic document-order search budget was exhausted. */
  exact: boolean;
  steps: number;
}

const WIDTH = 5;
const ORDER_SEARCH_LIMIT = 50_000;

function compare(a: ArrayLike<number>, aOffset: number, b: ArrayLike<number>, bOffset: number) {
  for (let k = 0; k < WIDTH; k++) {
    const difference = a[aOffset + k] - b[bOffset + k];
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Rectangular Hungarian assignment in the lexicographically ordered group Z^5. */
function assignment(rows: readonly Candidate[][], columns: number[]) {
  const n = rows.length;
  const complete = rows.every((row) => row.length === columns.length);
  if (
    complete &&
    rows.every((row) => row.every(({ score }, i) => compare(score, 0, rows[0][i].score, 0) === 0))
  ) {
    // When rows are interchangeable, the additive optimum selects the best old
    // columns. All permutations of that selection remain on the optimal face.
    const count = Math.min(n, columns.length);
    const ranked = [...rows[0]].sort(
      (a, b) => compare(b.score, 0, a.score, 0) || a.occurrence - b.occurrence,
    );
    const threshold = ranked[count - 1].score;
    const allowed = rows[0]
      .filter(({ score }) => compare(score, 0, threshold, 0) >= 0)
      .map(({ occurrence }) => occurrence);
    const required =
      n >= columns.length
        ? columns
        : rows[0]
            .filter(({ score }) => compare(score, 0, threshold, 0) > 0)
            .map(({ occurrence }) => occurrence);
    const selected = ranked
      .slice(0, count)
      .map(({ occurrence }) => occurrence)
      .sort((a, b) => a - b);
    return {
      initial: rows.map((_, i) => selected[i] ?? -1),
      tight: rows.map(() => (n > columns.length ? [...allowed, -1] : [...allowed])),
      required,
    };
  }
  if (
    complete &&
    rows.every((row) => row.every(({ score }) => compare(score, 0, row[0].score, 0) === 0))
  ) {
    // The transpose: interchangeable columns select the best written rows.
    const count = Math.min(n, columns.length);
    const ranked = rows
      .map((row, j) => ({ j, score: row[0].score }))
      .sort((a, b) => compare(b.score, 0, a.score, 0) || a.j - b.j);
    const threshold = ranked[count - 1].score;
    const selected = ranked
      .slice(0, count)
      .map(({ j }) => j)
      .sort((a, b) => a - b);
    const initial = Array<number>(n).fill(-1);
    selected.forEach((j, i) => {
      initial[j] = columns[i];
    });
    return {
      initial,
      tight: rows.map((row) => {
        const compared = compare(row[0].score, 0, threshold, 0);
        if (compared < 0) return [-1];
        return n > columns.length && compared === 0 ? [...columns, -1] : [...columns];
      }),
      required: n >= columns.length ? columns : [],
    };
  }
  // One dummy per written row lets strong precedence leave compatible links unmatched.
  const m = columns.length + n;
  const cost = new Float64Array(n * m * WIDTH);
  const localColumn = new Map(columns.map((column, i) => [column, i]));
  for (let row = 0; row < n; row++) {
    for (let column = 0; column < columns.length; column++) {
      // Ineligible edges lose even to the all-dummy assignment in the first component.
      cost[(row * m + column) * WIDTH] = n + 1;
    }
    for (const candidate of rows[row]) {
      const column = localColumn.get(candidate.occurrence);
      if (column === undefined) continue;
      for (let k = 0; k < WIDTH; k++) {
        cost[(row * m + column) * WIDTH + k] = -candidate.score[k];
      }
    }
  }
  const u = new Float64Array((n + 1) * WIDTH);
  const v = new Float64Array((m + 1) * WIDTH);
  const owner = new Int32Array(m + 1);
  const way = new Int32Array(m + 1);
  const reduced = new Float64Array(WIDTH);
  for (let row = 1; row <= n; row++) {
    owner[0] = row;
    let column = 0;
    const minima = new Float64Array((m + 1) * WIDTH);
    const reached = new Uint8Array(m + 1);
    const used = new Uint8Array(m + 1);
    do {
      used[column] = 1;
      const active = owner[column];
      let next = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        for (let k = 0; k < WIDTH; k++) {
          reduced[k] =
            cost[((active - 1) * m + j - 1) * WIDTH + k] - u[active * WIDTH + k] - v[j * WIDTH + k];
        }
        if (!reached[j] || compare(reduced, 0, minima, j * WIDTH) < 0) {
          for (let k = 0; k < WIDTH; k++) minima[j * WIDTH + k] = reduced[k];
          way[j] = column;
          reached[j] = 1;
        }
        if (next === 0 || compare(minima, j * WIDTH, minima, next * WIDTH) < 0) next = j;
      }
      const delta = minima.slice(next * WIDTH, (next + 1) * WIDTH);
      for (let j = 0; j <= m; j++) {
        for (let k = 0; k < WIDTH; k++) {
          if (used[j]) {
            u[owner[j] * WIDTH + k] += delta[k];
            v[j * WIDTH + k] -= delta[k];
          } else if (reached[j]) {
            minima[j * WIDTH + k] -= delta[k];
          }
        }
      }
      column = next;
    } while (owner[column] !== 0);
    do {
      const previous = way[column];
      owner[column] = owner[previous];
      column = previous;
    } while (column !== 0);
  }
  const initial = Array<number>(n).fill(-1);
  for (let column = 1; column <= columns.length; column++) {
    if (owner[column]) initial[owner[column] - 1] = columns[column - 1];
  }
  const tight = rows.map((candidates, row) => {
    const choices = candidates
      .filter((candidate) => {
        const column = localColumn.get(candidate.occurrence);
        if (column === undefined) return false;
        for (let k = 0; k < WIDTH; k++) {
          if (
            cost[(row * m + column) * WIDTH + k] !==
            u[(row + 1) * WIDTH + k] + v[(column + 1) * WIDTH + k]
          )
            return false;
        }
        return true;
      })
      .map(({ occurrence }) => occurrence);
    // Dummy column potentials are zero: there are n identical dummy columns.
    if (u.slice((row + 1) * WIDTH, (row + 2) * WIDTH).every((value) => value === 0))
      choices.push(-1);
    return choices;
  });
  const required = columns.filter((_, column) =>
    v.slice((column + 1) * WIDTH, (column + 2) * WIDTH).some((value) => value !== 0),
  );
  return { initial, tight, required };
}

function agreements(occurrences: readonly number[]) {
  let count = 0;
  for (let j = 0; j < occurrences.length; j++) {
    if (occurrences[j] < 0) continue;
    for (let k = j + 1; k < occurrences.length; k++) {
      if (occurrences[k] > occurrences[j]) count++;
    }
  }
  return count;
}

function earlier(a: readonly number[], b: readonly number[]) {
  for (let j = 0; j < a.length; j++) {
    if (a[j] === b[j]) continue;
    // For equal cardinality this is exactly the sorted (written, old) pair key.
    return a[j] >= 0 && (b[j] < 0 || a[j] < b[j]);
  }
  return false;
}

export function matchOccurrences(
  candidates: readonly Candidate[][],
  oldCount: number,
): MatchingResult {
  const occurrences = Array<number>(candidates.length).fill(-1);
  const tight: number[][] = candidates.map(() => [-1]);
  const required = new Uint8Array(oldCount);
  // Only the first five components are additive. Never complete order independently per component.
  const oldRows: number[][] = Array.from({ length: oldCount }, () => []);
  candidates.forEach((row, j) => {
    for (const { occurrence } of row) oldRows[occurrence].push(j);
  });
  const seen = new Uint8Array(candidates.length);
  for (let start = 0; start < candidates.length; start++) {
    if (seen[start] || candidates[start].length === 0) continue;
    const rows = [start];
    seen[start] = 1;
    const columns = new Set<number>();
    for (let cursor = 0; cursor < rows.length; cursor++) {
      for (const { occurrence } of candidates[rows[cursor]]) {
        if (columns.has(occurrence)) continue;
        columns.add(occurrence);
        for (const row of oldRows[occurrence]) {
          if (seen[row]) continue;
          seen[row] = 1;
          rows.push(row);
        }
      }
    }
    rows.sort((a, b) => a - b);
    const result = assignment(
      rows.map((j) => candidates[j]),
      [...columns].sort((a, b) => a - b),
    );
    rows.forEach((j, i) => {
      occurrences[j] = result.initial[i];
      tight[j] = result.tight[i];
    });
    for (const column of result.required) required[column] = 1;
  }
  const pairCount = occurrences.filter((i) => i >= 0).length;
  if (pairCount === 0) return { occurrences, exact: true, steps: 0 };

  // Interchangeable old columns must be used in increasing order: uncrossing them
  // strictly improves agreements without changing any of the five additive components.
  const signatures = Array.from({ length: oldCount }, (_, i) => `${required[i]}:`);
  tight.forEach((row, j) => {
    for (const i of row) if (i >= 0) signatures[i] += `${j},`;
  });
  const groups = new Map<string, number>();
  const groupOf = signatures.map((signature) => {
    if (!groups.has(signature)) groups.set(signature, groups.size);
    return groups.get(signature) as number;
  });
  const lastInGroup = Array<number>(groups.size).fill(-1);
  const groupSizes = Array<number>(groups.size).fill(0);
  const position = groupOf.map((group) => groupSizes[group]++);
  const availableOld = signatures.filter((signature) => signature.includes(",")).length;
  const minima = tight.map((row) =>
    row.reduce((min, i) => (i >= 0 ? Math.min(min, i) : min), oldCount),
  );
  const maxima = tight.map((row) => Math.max(-1, ...row));
  const futurePairs = Array<number>(tight.length + 1).fill(0);
  for (let j = tight.length - 1; j >= 0; j--) {
    futurePairs[j] = futurePairs[j + 1];
    for (let k = j + 1; k < tight.length; k++) if (minima[j] < maxima[k]) futurePairs[j]++;
  }
  const futureHigher = Array.from({ length: tight.length + 1 }, () => new Uint32Array(oldCount));
  for (let j = tight.length - 1; j >= 0; j--) {
    for (let i = 0; i < oldCount; i++) {
      futureHigher[j][i] = futureHigher[j + 1][i] + Number(i < maxima[j]);
    }
  }
  const upperBound = Math.min((pairCount * (pairCount - 1)) / 2, futurePairs[0]);
  let best = [...occurrences];
  let bestOrder = agreements(best);
  let steps = 0;
  let exhausted = false;
  let certified = false;
  const used = new Uint8Array(oldCount);
  const current = Array<number>(tight.length).fill(-1);
  const initialRequired = required.reduce((sum, value) => sum + value, 0);
  const search = (j: number, pairs: number, order: number, missing: number, available: number) => {
    if (exhausted || certified) return;
    if (
      pairs > pairCount ||
      pairs + Math.min(available, tight.length - j) < pairCount ||
      missing > tight.length - j
    )
      return;
    if (j === tight.length) {
      if (missing !== 0 || pairs !== pairCount) return;
      if (order > bestOrder || (order === bestOrder && earlier(current, best))) {
        best = [...current];
        bestOrder = order;
      }
      // Traversal is explicitly lexicographic document order. The first leaf attaining
      // a proven global bound also wins the final document-order tie-break.
      if (order === upperBound) {
        best = [...current];
        certified = true;
      }
      return;
    }
    let possible = order + futurePairs[j];
    for (let k = 0; k < j; k++) {
      if (current[k] < 0) continue;
      possible += futureHigher[j][current[k]];
    }
    if (possible < bestOrder) return;
    // Old choices are sorted, unmatched last. This is policy, not Hungarian enumeration order.
    for (const i of tight[j]) {
      if (steps === ORDER_SEARCH_LIMIT) {
        exhausted = true;
        return;
      }
      steps++;
      if (i >= 0 && (used[i] || i <= lastInGroup[groupOf[i]])) continue;
      current[j] = i;
      if (i < 0) {
        search(j + 1, pairs, order, missing, available);
      } else {
        let gained = 0;
        for (let k = 0; k < j; k++) if (current[k] >= 0 && current[k] < i) gained++;
        const group = groupOf[i];
        const previous = lastInGroup[group];
        const removed = position[i] - (previous < 0 ? -1 : position[previous]);
        // A required interchangeable column cannot be skipped: it would be unreachable later.
        if (required[i] && removed !== 1) continue;
        lastInGroup[group] = i;
        used[i] = 1;
        search(j + 1, pairs + 1, order + gained, missing - required[i], available - removed);
        used[i] = 0;
        lastInGroup[group] = previous;
      }
      if (exhausted || certified) return;
    }
    current[j] = -1;
  };
  search(0, 0, 0, initialRequired, availableOld);
  return { occurrences: best, exact: !exhausted, steps };
}
