// Aligns a scope's current blocks with their replacement so equal blocks stay untouched.

import type { Block } from "../codec-types.js";
import { weightedOrderedMatches } from "../ordered-matching.js";

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

/** Only changed pairs and adjacent unpaired blocks can share structural identity. */
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
    const parents = gap.map((_, index) => index);
    const root = (index: number): number => {
      while (parents[index] !== index) {
        parents[index] = parents[parents[index]];
        index = parents[index];
      }
      return index;
    };
    const union = (owners: number[]) => {
      for (const owner of owners) parents[root(owner)] = root(owners[0]);
    };
    // Adjacent structural steps already form one physical insert/delete run.
    for (let index = 1; index < gap.length; index++) {
      if (
        (gap[index].kind === "add" || gap[index].kind === "remove") &&
        (gap[index - 1].kind === "add" || gap[index - 1].kind === "remove")
      )
        union([index - 1, index]);
    }
    const words = new Intl.Segmenter(undefined, { granularity: "word" });
    for (let index = 0; index < gap.length; index++) {
      const pair = gap[index];
      if (pair.kind !== "change") continue;
      for (const kind of ["add", "remove"] as const) {
        const blocks = kind === "add" ? newBlocks : oldBlocks;
        const pairedIndex = kind === "add" ? pair.next : pair.old;
        const reference = kind === "add" ? oldBlocks[pair.old] : newBlocks[pair.next];
        for (const direction of [-1, 1]) {
          let edge = blocks[pairedIndex].textContent;
          for (
            let candidate = index + direction;
            candidate >= 0 && candidate < gap.length;
            candidate += direction
          ) {
            const step = gap[candidate];
            if (step.kind === "change") break;
            if (step.kind !== kind) continue;
            const text = blocks[step.kind === "add" ? step.next : step.old].textContent;
            const left = direction < 0 ? text : edge,
              right = direction < 0 ? edge : text;
            if (!boundaryContinues(reference.textContent, left, right, words)) break;
            union([index, candidate]);
            edge = text;
          }
        }
      }
    }
    const components = new Map<number, BlockAlignmentStep[]>();
    gap.forEach((step, index) => {
      const key = root(index),
        members = components.get(key) ?? [];
      members.push(step);
      components.set(key, members);
    });
    for (const members of components.values()) {
      if (members.length < 2) continue;
      const identity = {};
      for (const step of members) step.structuralBoundary = identity;
    }
  }
}

const MAX_BOUNDARY_CHARACTERS = 4096;
const MAX_BOUNDARY_CELLS = 65536;

/** Bounded token LCS: retained prose must continue immediately across this boundary. */
function boundaryContinues(
  reference: string,
  left: string,
  right: string,
  words: Intl.Segmenter,
): boolean {
  left = left.trimEnd();
  right = right.trimStart();
  if (reference.length + left.length + right.length > MAX_BOUNDARY_CHARACTERS) return true;
  const joined = left + right,
    boundary = left.length;
  const parts = (text: string) =>
    [...words.segment(text)].filter((part) => !/^\s+$/u.test(part.segment));
  const proposed = parts(joined);
  const crossing = proposed.find(
    (part) => part.index < boundary && part.index + part.segment.length > boundary,
  );
  const subwords = new Set<string>();
  if (crossing) {
    const cut = boundary - crossing.index;
    subwords.add(crossing.segment);
    subwords.add(crossing.segment.slice(0, cut));
    subwords.add(crossing.segment.slice(cut));
  }
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const tokenize = (segments: ReturnType<typeof parts>) =>
    segments.flatMap((part) =>
      subwords.has(part.segment)
        ? [...graphemes.segment(part.segment)].map((piece) => ({
            text: piece.segment,
            index: part.index + piece.index,
          }))
        : [{ text: part.segment, index: part.index }],
    );
  const source = tokenize(parts(reference)),
    target = tokenize(proposed);
  const split = target.findIndex((token) => token.index >= boundary);
  if (split <= 0) return false;
  // The explicit boundary cannot match prose; its neighbors must both be retained.
  target.splice(split, 0, { text: "", index: boundary });
  const matches = weightedOrderedMatches(
    (a, b) => (source[a].text === target[b].text ? 1 : 0),
    0,
    source.length,
    0,
    target.length,
    MAX_BOUNDARY_CELLS,
  );
  if (!matches) return true;
  const before = matches.findIndex(([, next]) => next === split - 1);
  return (
    before >= 0 &&
    matches[before + 1]?.[1] === split + 1 &&
    matches[before + 1][0] === matches[before][0] + 1
  );
}
