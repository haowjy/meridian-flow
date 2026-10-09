// Exact lexicographic link assignment with explicit document-order completion on its optimal face.

export interface CandidateRow {
  occurrences: number[];
  /** Six tuple components per compatible occurrence, in the same order. */
  scores: number[];
}
const WIDTH = 6;

function compare(a: ArrayLike<number>, aOffset: number, b: ArrayLike<number>, bOffset: number) {
  for (let k = 0; k < WIDTH; k++) {
    const difference = a[aOffset + k] - b[bOffset + k];
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Choose the earliest document key among optimal assignments, independently of Hungarian traversal. */
function documentOrder(
  tight: readonly number[][],
  matching: Int32Array,
  owner: Int32Array,
  required: Uint8Array,
  oldColumns: number,
) {
  const dummy = matching.length;
  const parent = new Int32Array(dummy + 1);
  const via = new Int32Array(dummy + 1);
  const queue = new Int32Array(dummy + 1);
  const optional = Array.from({ length: owner.length }, (_, i) => i).filter((i) => !required[i]);

  const force = (row: number, column: number) => {
    const previous = matching[row];
    const displaced = owner[column];
    owner[previous] = -1;
    owner[column] = row;
    matching[row] = column;
    if (displaced < 0 && !required[previous]) return true;

    parent.fill(-2);
    const start = displaced < 0 ? dummy : displaced;
    parent[start] = -1;
    queue[0] = start;
    let count = 1;
    for (let cursor = 0; cursor < count; cursor++) {
      const active = queue[cursor];
      // A synthetic dummy row represents unassigned optional columns. It allows
      // alternating paths to exchange free columns without leaving a required one free.
      const choices = active === dummy ? optional : tight[active];
      for (const nextColumn of choices) {
        if (nextColumn === previous || (owner[nextColumn] < 0 && !required[previous])) {
          let current = active;
          let chosen = nextColumn;
          while (current >= 0) {
            if (current === dummy) {
              owner[chosen] = -1;
            } else {
              matching[current] = chosen;
              owner[chosen] = current;
            }
            chosen = via[current];
            current = parent[current];
          }
          return true;
        }
        const next = owner[nextColumn] < 0 ? dummy : owner[nextColumn];
        if (next <= row || parent[next] !== -2) continue;
        parent[next] = active;
        via[next] = nextColumn;
        queue[count++] = next;
      }
    }
    owner[previous] = row;
    owner[column] = displaced;
    matching[row] = previous;
    return false;
  };

  for (let row = 0; row < matching.length; row++) {
    for (const column of tight[row]) {
      // Real columns are sorted by old occurrence, before equivalent unmatched dummies.
      if (column >= oldColumns || column === matching[row]) break;
      if (owner[column] >= 0 && owner[column] < row) continue;
      if (force(row, column)) break;
    }
  }
}

/** Rectangular Hungarian assignment in the lexicographically ordered group Z^6. */
function assignment(
  rows: readonly number[],
  columns: readonly number[],
  candidates: readonly CandidateRow[],
) {
  const n = rows.length;
  const complete = rows.every((row) => candidates[row].occurrences.length === columns.length);
  // On a complete graph any maximum-strong matching extends to maximum cardinality.
  // Else keep one dummy per written row: strong precedence can sacrifice compatible pairs.
  const m = complete ? Math.max(columns.length, n) : columns.length + n;
  const cost = new Float64Array(n * m * WIDTH);
  const localColumn = new Map(columns.map((column, i) => [column, i]));
  for (let row = 0; row < n; row++) {
    for (let column = 0; column < columns.length; column++) {
      // One ineligible edge loses even to all dummies in the first tuple component.
      cost[(row * m + column) * WIDTH] = n + 1;
    }
    const candidate = candidates[rows[row]];
    candidate.occurrences.forEach((occurrence, i) => {
      const column = localColumn.get(occurrence) as number;
      for (let k = 0; k < WIDTH; k++)
        cost[(row * m + column) * WIDTH + k] = -candidate.scores[i * WIDTH + k];
    });
  }
  const u = new Float64Array((n + 1) * WIDTH);
  const v = new Float64Array((m + 1) * WIDTH);
  if (m === n) {
    // Square assignments cover every column. Subtracting each column minimum is
    // dual-feasible here and avoids repeatedly rediscovering column-constant ranks.
    // Rectangular assignments leave columns free, so their potentials must start at zero.
    for (let column = 0; column < m; column++) {
      let minimum = column * WIDTH;
      for (let row = 1; row < n; row++) {
        const offset = (row * m + column) * WIDTH;
        if (compare(cost, offset, cost, minimum) < 0) minimum = offset;
      }
      for (let k = 0; k < WIDTH; k++) v[(column + 1) * WIDTH + k] = cost[minimum + k];
    }
  }
  const hungarianOwner = new Int32Array(m + 1);
  const way = new Int32Array(m + 1);
  const reduced = new Float64Array(WIDTH);
  const minima = new Float64Array((m + 1) * WIDTH);
  const reached = new Uint8Array(m + 1);
  const used = new Uint8Array(m + 1);
  const delta = new Float64Array(WIDTH);
  for (let row = 1; row <= n; row++) {
    hungarianOwner[0] = row;
    let column = 0;
    reached.fill(0);
    used.fill(0);
    do {
      used[column] = 1;
      const active = hungarianOwner[column];
      let next = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        let compared = reached[j] ? 0 : -1;
        const costOffset = ((active - 1) * m + j - 1) * WIDTH;
        const rowOffset = active * WIDTH;
        const columnOffset = j * WIDTH;
        for (let k = 0; k < WIDTH; k++) {
          reduced[k] = cost[costOffset + k] - u[rowOffset + k] - v[columnOffset + k];
          if (compared === 0 && reduced[k] !== minima[columnOffset + k]) {
            compared = reduced[k] < minima[columnOffset + k] ? -1 : 1;
            if (compared > 0) break;
          }
        }
        if (compared < 0) {
          for (let k = 0; k < WIDTH; k++) minima[columnOffset + k] = reduced[k];
          way[j] = column;
          reached[j] = 1;
        }
        if (next === 0 || compare(minima, j * WIDTH, minima, next * WIDTH) < 0) next = j;
      }
      for (let k = 0; k < WIDTH; k++) delta[k] = minima[next * WIDTH + k];
      for (let j = 0; j <= m; j++) {
        const offset = j * WIDTH;
        if (used[j]) {
          const rowOffset = hungarianOwner[j] * WIDTH;
          for (let k = 0; k < WIDTH; k++) {
            u[rowOffset + k] += delta[k];
            v[offset + k] -= delta[k];
          }
        } else if (reached[j]) {
          for (let k = 0; k < WIDTH; k++) minima[offset + k] -= delta[k];
        }
      }
      column = next;
    } while (hungarianOwner[column] !== 0);
    do {
      const previous = way[column];
      hungarianOwner[column] = hungarianOwner[previous];
      column = previous;
    } while (column !== 0);
  }

  const matching = new Int32Array(n);
  const owner = new Int32Array(m).fill(-1);
  const required = new Uint8Array(m);
  for (let column = 1; column <= m; column++) {
    if (hungarianOwner[column]) {
      matching[hungarianOwner[column] - 1] = column - 1;
      owner[column - 1] = hungarianOwner[column] - 1;
    }
    for (let k = 0; k < WIDTH; k++) if (v[column * WIDTH + k] !== 0) required[column - 1] = 1;
  }
  const tight = rows.map((globalRow, row) => {
    const choices: number[] = [];
    for (const occurrence of candidates[globalRow].occurrences) {
      const column = localColumn.get(occurrence) as number;
      let zero = true;
      for (let k = 0; k < WIDTH; k++) {
        if (
          cost[(row * m + column) * WIDTH + k] !==
          u[(row + 1) * WIDTH + k] + v[(column + 1) * WIDTH + k]
        ) {
          zero = false;
          break;
        }
      }
      if (zero) choices.push(column);
    }
    choices.sort((a, b) => a - b);
    // Square complete components can own every dummy, giving nonzero dummy potentials.
    // Test their actual reduced costs, just like real columns.
    for (let column = columns.length; column < m; column++) {
      let zero = true;
      for (let k = 0; k < WIDTH; k++) {
        if (u[(row + 1) * WIDTH + k] + v[(column + 1) * WIDTH + k] !== 0) {
          zero = false;
          break;
        }
      }
      if (zero) choices.push(column);
    }
    return choices;
  });
  documentOrder(tight, matching, owner, required, columns.length);
  return Array.from(matching, (column) => columns[column] ?? -1);
}

export function matchOccurrences(candidates: readonly CandidateRow[], oldCount: number): number[] {
  const occurrences = Array<number>(candidates.length).fill(-1);
  const oldRows: number[][] = Array.from({ length: oldCount }, () => []);
  candidates.forEach((row, j) => {
    for (const occurrence of row.occurrences) oldRows[occurrence].push(j);
  });
  const seen = new Uint8Array(candidates.length);
  for (let start = 0; start < candidates.length; start++) {
    if (seen[start] || candidates[start].occurrences.length === 0) continue;
    const rows = [start];
    seen[start] = 1;
    const columns = new Set<number>();
    for (let cursor = 0; cursor < rows.length; cursor++) {
      for (const occurrence of candidates[rows[cursor]].occurrences) {
        if (columns.has(occurrence)) continue;
        columns.add(occurrence);
        for (const row of oldRows[occurrence]) {
          if (seen[row]) continue;
          seen[row] = 1;
          rows.push(row);
        }
      }
    }
    // All six ranks are additive, but their displacement scores use the original global indices.
    rows.sort((a, b) => a - b);
    const result = assignment(
      rows,
      [...columns].sort((a, b) => a - b),
      candidates,
    );
    rows.forEach((j, i) => {
      occurrences[j] = result[i];
    });
  }
  return occurrences;
}
