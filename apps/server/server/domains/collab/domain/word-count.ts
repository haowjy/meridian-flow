/** Shared word-count semantics for draft review and durable change trails. */

import { bodyFromHashline } from "./trail-read-kernel.js";

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

/** Normalizes captured protocol hashlines to the prose writers saw before diffing. */
export function wordDeltaBetweenHashlines(
  beforeSerialized: string | null,
  afterSerialized: string | null,
): WordDelta {
  const before = bodyFromHashline(beforeSerialized);
  const after = bodyFromHashline(afterSerialized);
  return wordDeltaBetweenTexts(
    before.status === "available" ? before.markdown : "",
    after.status === "available" ? after.markdown : "",
  );
}
