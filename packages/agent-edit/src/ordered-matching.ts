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
