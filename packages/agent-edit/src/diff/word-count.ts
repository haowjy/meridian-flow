/**
 * The one word-count semantics: the turn receipt's durable trail deltas (server) and a review change's
 * delta (the draft dock) both count whole word tokens in the shortest insertion/deletion edit script.
 */
import type { BlockDiff } from "./hunks.js";
import type { ReviewGroup } from "./review.js";
import type { Tok } from "./tokens.js";

export type WordDelta = { wordsAdded: number; wordsRemoved: number };

export function countWords(text: string): number {
  return wordTokens(text).length;
}

function wordTokens(text: string): string[] {
  return text.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
}

/**
 * Finds the shortest token edit script without materializing it.
 * Myers' frontier keeps ordinary small prose edits linear while avoiding the
 * character-fragment behavior of text diff libraries.
 */
function tokenEditDistance(before: readonly string[], after: readonly string[]): number {
  const maximum = before.length + after.length;
  const frontier = new Map<number, number>([[1, 0]]);
  for (let distance = 0; distance <= maximum; distance += 1) {
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const deletion = (frontier.get(diagonal - 1) ?? -1) + 1;
      const insertion = frontier.get(diagonal + 1) ?? -1;
      let beforeIndex =
        diagonal === -distance || (diagonal !== distance && deletion < insertion)
          ? insertion
          : deletion;
      let afterIndex = beforeIndex - diagonal;
      while (
        beforeIndex < before.length &&
        afterIndex < after.length &&
        before[beforeIndex] === after[afterIndex]
      ) {
        beforeIndex += 1;
        afterIndex += 1;
      }
      if (beforeIndex >= before.length && afterIndex >= after.length) return distance;
      frontier.set(diagonal, beforeIndex);
    }
  }
  return maximum;
}

/** Counts whole word tokens in the shortest insertion/deletion edit script. */
export function wordDeltaBetweenTexts(before: string, after: string): WordDelta {
  const beforeTokens = wordTokens(before);
  const afterTokens = wordTokens(after);
  const distance = tokenEditDistance(beforeTokens, afterTokens);
  const lengthDelta = afterTokens.length - beforeTokens.length;
  return {
    wordsAdded: (distance + lengthDelta) / 2,
    wordsRemoved: (distance - lengthDelta) / 2,
  };
}

// A block boundary separates words; a non-text block (list, table) contributes its text.
const tokText = (tok: Tok) =>
  tok.kind === "text"
    ? tok.ws + tok.core
    : tok.kind === "atom"
      ? `\n${tok.node.textContent}\n`
      : "\n";

const groupDeltas = new WeakMap<ReviewGroup, WordDelta>();

/**
 * A review change's word delta: each hunk's base text against what it wrote, so a change that only
 * restyles or respaces words counts none, and a moved paragraph counts where it left and where it landed.
 */
export function groupWordDelta(diff: BlockDiff, group: ReviewGroup): WordDelta {
  const cached = groupDeltas.get(group);
  if (cached) return cached;
  const total: WordDelta = { wordsAdded: 0, wordsRemoved: 0 };
  for (const { index } of group.hunks) {
    const hunk = diff.hunks[index];
    const delta = wordDeltaBetweenTexts(
      diff.base.toks.slice(hunk.from, hunk.to).map(tokText).join(""),
      hunk.ins.map(tokText).join(""),
    );
    total.wordsAdded += delta.wordsAdded;
    total.wordsRemoved += delta.wordsRemoved;
  }
  groupDeltas.set(group, total);
  return total;
}
