// Aligns a scope's current blocks with their replacement so equal blocks stay untouched.

import type { Block } from "../codec-types.js";

export type BlockAlignmentStep =
  | { kind: "keep"; old: number; next: number }
  | { kind: "change"; old: number; next: number }
  | { kind: "remove"; old: number }
  | { kind: "add"; next: number };

/** Whether `next` may rewrite `old` in place (a `change` step). */
export type CanPair = (old: Block, next: Block) => boolean;

/** Past this many cells a table costs more than rewriting the gap. */
const MAX_TABLE_CELLS = 4_000_000;

/**
 * Keeps the longest run of equal blocks in order (LCS over whole blocks). The
 * blocks left between two kept ones are paired by similarity first: a pair
 * `canPair` accepts that shares enough text at its edges is changed in place,
 * so inserting a paragraph before one being edited doesn't hand the edited
 * one's element (and its comments) to the new paragraph. What remains pairs by
 * position where `canPair` allows and is otherwise removed or added. Common leading and trailing blocks are matched before any table so
 * a local edit stays cheap in a long document.
 */
export function alignBlocks(
  oldBlocks: readonly Block[],
  newBlocks: readonly Block[],
  canPair: CanPair,
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
  const equal = (oldIndex: number, newIndex: number) =>
    oldBlocks[oldIndex].eq(newBlocks[newIndex]) ? 1 : 0;
  const matches = heaviestMatches(equal, start, oldEnd, start, newEnd);
  let oldCursor = start;
  let newCursor = start;
  for (const [oldIndex, newIndex] of [...matches, [oldEnd, newEnd] as const]) {
    pairGap(steps, oldBlocks, newBlocks, canPair, oldCursor, oldIndex, newCursor, newIndex);
    if (oldIndex < oldEnd) steps.push({ kind: "keep", old: oldIndex, next: newIndex });
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
  for (let offset = 0; oldEnd + offset < oldBlocks.length; offset += 1) {
    steps.push({ kind: "keep", old: oldEnd + offset, next: newEnd + offset });
  }
  return steps;
}

function pairGap(
  steps: BlockAlignmentStep[],
  oldBlocks: readonly Block[],
  newBlocks: readonly Block[],
  canPair: CanPair,
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): void {
  const oldTexts = new Map<number, string>();
  const newTexts = new Map<number, string>();
  const textOf = (texts: Map<number, string>, block: Block, index: number) => {
    let text = texts.get(index);
    if (text === undefined) {
      text = block.textContent;
      texts.set(index, text);
    }
    return text;
  };
  const similarity = (oldIndex: number, newIndex: number) => {
    const old = oldBlocks[oldIndex];
    const next = newBlocks[newIndex];
    if (!canPair(old, next)) return 0;
    return edgeSimilarity(textOf(oldTexts, old, oldIndex), textOf(newTexts, next, newIndex));
  };
  // Past the table cap there are no similarity pairs and the gap is paired by
  // position alone, the pre-alignment behaviour. Only a rewrite of thousands
  // of blocks between unchanged ones gets here, and the equal-block LCS above
  // has then also given up, so the whole middle is this one gap.
  const similar = tableFits(oldEnd - oldStart, newEnd - newStart)
    ? heaviestMatches(similarity, oldStart, oldEnd, newStart, newEnd)
    : [];
  let oldCursor = oldStart;
  let newCursor = newStart;
  for (const [oldIndex, newIndex] of [...similar, [oldEnd, newEnd] as const]) {
    // Blocks left between two similar pairs still pair by position, so an
    // unrelated rewrite keeps its paragraphs and a writer typing in them
    // concurrently keeps their words.
    const paired = Math.min(oldIndex - oldCursor, newIndex - newCursor);
    for (let offset = 0; offset < paired; offset += 1) {
      const old = oldCursor + offset;
      const next = newCursor + offset;
      if (canPair(oldBlocks[old], newBlocks[next])) steps.push({ kind: "change", old, next });
      else steps.push({ kind: "remove", old }, { kind: "add", next });
    }
    for (let old = oldCursor + paired; old < oldIndex; old += 1)
      steps.push({ kind: "remove", old });
    for (let next = newCursor + paired; next < newIndex; next += 1)
      steps.push({ kind: "add", next });
    if (oldIndex < oldEnd) steps.push({ kind: "change", old: oldIndex, next: newIndex });
    oldCursor = oldIndex + 1;
    newCursor = newIndex + 1;
  }
}

/**
 * Weight for rewriting one block as another: the text both keep at their
 * start and end, plus one so two empty blocks still pair. Below a third of the
 * shorter text the two count as unrelated and don't compete with a real match;
 * a stray shared full stop must not outrank the paragraph's own rewrite.
 */
function edgeSimilarity(oldText: string, newText: string): number {
  const limit = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < limit && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) ===
      newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  const shared = prefix + suffix;
  return shared * 3 >= limit ? shared + 1 : 0;
}

function tableFits(rows: number, columns: number): boolean {
  return (rows + 1) * (columns + 1) <= MAX_TABLE_CELLS;
}

/**
 * The in-order pairs with the largest total weight (weight 0 never pairs).
 * With 0/1 weights this is the longest common subsequence.
 */
function heaviestMatches(
  weight: (oldIndex: number, newIndex: number) => number,
  oldStart: number,
  oldEnd: number,
  newStart: number,
  newEnd: number,
): Array<readonly [number, number]> {
  const rows = oldEnd - oldStart;
  const columns = newEnd - newStart;
  if (rows === 0 || columns === 0 || !tableFits(rows, columns)) return [];

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
