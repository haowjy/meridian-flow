// Aligns a scope's current blocks with their replacement so equal blocks stay untouched.

import type { Block } from "../codec-types.js";
import { weightedOrderedMatches } from "../ordered-matching.js";
import { wordHunks } from "../word-hunks.js";

export type BlockAlignmentStep = { structuralBoundary?: object } & (
  | { kind: "keep"; old: number; next: number }
  | { kind: "change"; old: number; next: number }
  | { kind: "remove"; old: number }
  | { kind: "add"; next: number }
);

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
  const matches =
    weightedOrderedMatches(equal, start, oldEnd, start, newEnd, MAX_TABLE_CELLS) ?? [];
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
  recognizeBoundaries(steps, oldBlocks, newBlocks);
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
  const similar =
    weightedOrderedMatches(similarity, oldStart, oldEnd, newStart, newEnd, MAX_TABLE_CELLS) ?? [];
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

/** Word correspondence across adjacent blocks identifies split/merge boundaries before lowering.
 * Kept blocks fence the correspondence search; unrelated insertions never inherit a boundary.
 */
function recognizeBoundaries(
  steps: BlockAlignmentStep[],
  oldBlocks: readonly Block[],
  newBlocks: readonly Block[],
): void {
  let start = 0;
  for (let end = 0; end <= steps.length; end++) {
    if (end !== steps.length && steps[end].kind !== "keep") continue;
    const gap = steps.slice(start, end);
    start = end + 1;
    if (
      !gap.some((step) => step.kind === "change") ||
      !gap.some((step) => step.kind === "add" || step.kind === "remove")
    )
      continue;
    const oldIndices = gap.flatMap((step) => ("old" in step ? [step.old] : []));
    const newIndices = gap.flatMap((step) => ("next" in step ? [step.next] : []));
    const positions = (indices: number[], blocks: readonly Block[]) => {
      let offset = 0;
      return indices.map((index) => {
        const from = offset;
        offset += blocks[index].textContent.length + 2;
        return { index, from, to: offset - 2 };
      });
    };
    const oldPositions = positions(oldIndices, oldBlocks);
    const newPositions = positions(newIndices, newBlocks);
    const before = oldIndices.map((index) => oldBlocks[index].textContent).join("\n\n");
    const after = newIndices.map((index) => newBlocks[index].textContent).join("\n\n");
    const correspondences = new Map<number, Set<number>>();
    let oldCursor = 0,
      newCursor = 0;
    const equal = (oldEnd: number) => {
      const text = before.slice(oldCursor, oldEnd);
      for (const match of text.matchAll(/[\p{L}\p{N}\p{M}_]+/gu)) {
        const oldOffset = oldCursor + match.index;
        const newOffset = newCursor + match.index;
        const old = oldPositions.find((pos) => oldOffset >= pos.from && oldOffset < pos.to);
        const next = newPositions.find((pos) => newOffset >= pos.from && newOffset < pos.to);
        if (!old || !next) continue;
        const targets = correspondences.get(old.index) ?? new Set<number>();
        targets.add(next.index);
        correspondences.set(old.index, targets);
      }
      newCursor += oldEnd - oldCursor;
    };
    for (const hunk of wordHunks(before, after)) {
      equal(hunk.from);
      oldCursor = hunk.to;
      newCursor += hunk.text.length;
    }
    equal(before.length);
    const owners = new Map<BlockAlignmentStep, Set<BlockAlignmentStep>>();
    for (const change of gap) {
      if (change.kind !== "change") continue;
      for (const structure of gap) {
        const split =
          structure.kind === "add" &&
          correspondences.get(change.old)?.has(change.next) &&
          correspondences.get(change.old)?.has(structure.next);
        const merge =
          structure.kind === "remove" &&
          correspondences.get(change.old)?.has(change.next) &&
          correspondences.get(structure.old)?.has(change.next);
        if (!split && !merge) continue;
        const group = owners.get(change) ?? new Set([change]);
        group.add(structure);
        owners.set(change, group);
      }
    }
    // Only consecutive document boundaries belong to a group, never a skipped block.
    for (const group of owners.values()) {
      const members = [...group];
      const indexes = members.map((step) => gap.indexOf(step)).sort((a, b) => a - b);
      if (indexes.some((index, offset) => offset > 0 && index !== indexes[offset - 1] + 1))
        continue;
      const boundary = {};
      for (const member of members) member.structuralBoundary = boundary;
    }
  }
}
