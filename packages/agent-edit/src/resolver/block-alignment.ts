// Aligns a scope's current blocks with their replacement so equal blocks stay untouched.

import type { Block } from "../codec-types.js";

export type BlockAlignmentStep =
  | { kind: "keep"; old: number; next: number }
  | { kind: "change"; old: number; next: number }
  | { kind: "remove"; old: number }
  | { kind: "add"; next: number };

/** Past this many cells the LCS table costs more than rewriting the gap. */
const MAX_LCS_CELLS = 4_000_000;

/**
 * Keeps the longest run of equal blocks in order (LCS over whole blocks), then
 * pairs the blocks left between two kept ones by position. A paired block is
 * changed in place; the rest are removed or added. Common leading and trailing
 * blocks are matched before the table so a local edit stays cheap in a long
 * document.
 */
export function alignBlocks(
  oldBlocks: readonly Block[],
  newBlocks: readonly Block[],
): BlockAlignmentStep[] {
  let start = 0;
  while (
    start < oldBlocks.length &&
    start < newBlocks.length &&
    oldBlocks[start].eq(newBlocks[start])
  ) {
    start += 1;
  }
  let oldEnd = oldBlocks.length;
  let newEnd = newBlocks.length;
  while (oldEnd > start && newEnd > start && oldBlocks[oldEnd - 1].eq(newBlocks[newEnd - 1])) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const steps: BlockAlignmentStep[] = [];
  for (let index = 0; index < start; index += 1) {
    steps.push({ kind: "keep", old: index, next: index });
  }
  const matches = middleMatches(oldBlocks, newBlocks, start, oldEnd, start, newEnd);
  let oldCursor = start;
  let newCursor = start;
  for (const [oldIndex, newIndex] of [...matches, [oldEnd, newEnd] as const]) {
    pairGap(steps, oldCursor, oldIndex, newCursor, newIndex);
    if (oldIndex < oldEnd) steps.push({ kind: "keep", old: oldIndex, next: newIndex });
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
  for (let offset = 0; oldEnd + offset < oldBlocks.length; offset += 1) {
    steps.push({ kind: "keep", old: oldEnd + offset, next: newEnd + offset });
  }
  return steps;
}

function middleMatches(
  oldBlocks: readonly Block[],
  newBlocks: readonly Block[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): Array<readonly [number, number]> {
  const rows = oldEnd - oldStart;
  const columns = newEnd - newStart;
  if (rows === 0 || columns === 0 || (rows + 1) * (columns + 1) > MAX_LCS_CELLS) return [];

  const width = columns + 1;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      lengths[row * width + column] = oldBlocks[oldStart + row].eq(newBlocks[newStart + column])
        ? lengths[(row + 1) * width + column + 1] + 1
        : Math.max(lengths[(row + 1) * width + column], lengths[row * width + column + 1]);
    }
  }

  const matches: Array<readonly [number, number]> = [];
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (oldBlocks[oldStart + row].eq(newBlocks[newStart + column])) {
      matches.push([oldStart + row, newStart + column]);
      row += 1;
      column += 1;
    } else if (lengths[(row + 1) * width + column] >= lengths[row * width + column + 1]) {
      row += 1;
    } else {
      column += 1;
    }
  }
  return matches;
}

function pairGap(
  steps: BlockAlignmentStep[],
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): void {
  const paired = Math.min(oldEnd - oldStart, newEnd - newStart);
  for (let offset = 0; offset < paired; offset += 1) {
    steps.push({ kind: "change", old: oldStart + offset, next: newStart + offset });
  }
  for (let old = oldStart + paired; old < oldEnd; old += 1) steps.push({ kind: "remove", old });
  for (let next = newStart + paired; next < newEnd; next += 1) steps.push({ kind: "add", next });
}
