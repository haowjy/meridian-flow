/** Counts visible word magnitude for pending draft review changes. */

export type DraftWordDelta = {
  wordsAdded: number;
  wordsRemoved: number;
};

export function countWhitespaceSeparatedWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/u).length;
}

export function sumDraftWordDelta(
  changes: readonly { insertedText: string; deletedText: string }[],
): DraftWordDelta {
  return changes.reduce<DraftWordDelta>(
    (total, change) => ({
      wordsAdded: total.wordsAdded + countWhitespaceSeparatedWords(change.insertedText),
      wordsRemoved: total.wordsRemoved + countWhitespaceSeparatedWords(change.deletedText),
    }),
    { wordsAdded: 0, wordsRemoved: 0 },
  );
}
