/**
 * Every rule the content merge applies beyond a plain merge (a change only one side made applies; the
 * same change on both sides applies once). This is the only place a rule's name is declared: adding
 * one is the owner's decision (`../../.context/content-merge.md`), and it needs a case row.
 */
export const RULES = {
  // Where the two sides change the same words
  "draft-wins-text": "Both sides changed the same words differently: the draft's text stands.",
  "whole-block-unit":
    "A figure or table is one token, so a change on both sides is one clash: the draft's whole block stands.",
  "containers-merged":
    "Both sides changed a table kept as the same shape: its rows and cells merge one by one.",
  "draft-wins-stretch":
    "One side removed a block the other changed, or both changed which blocks are at one place: the draft's blocks stand there.",
  "block-attributes-merged":
    "A block both sides kept takes each attribute from the side that changed it, the draft's where both did.",
  // Where the two sides add or move text
  "insertions-kept-both": "Both sides inserted at one point: both stay, live's first.",
  "same-block-added-twice":
    "Both sides made the same block at one place: it is one block, with live's id.",
  "marks-merged":
    "Both sides only reformatted one word: each mark comes from the side that changed it.",
  "shared-edge-kept-once":
    "One side inserted words the other side's replacement also starts or ends with: kept once.",
  "typed-at-end-of-deleted":
    "Words typed at the end of a paragraph the other side deleted are a clash, not a join onto the paragraph before.",
  "moved-text-dropped":
    "Live cut and pasted text the draft changed at its source: live's paste is left out, the draft's text stays.",
  "neighbouring-changes-joined":
    "Two one-sided changes within three unchanged tokens are one change the two diffs placed differently.",
  // Block order
  "moved-paragraph-keeps-edits":
    "A block one side moved is paired with its old self, so the other side's edits go with it.",
  "draft-wins-order":
    "Both sides moved one block to different places, or the two orders cannot both hold: the draft's order.",
  // Whitespace
  "draft-wins-space": "Both sides changed the space before one word differently: the draft's.",
  "space-added-between-words":
    "Two words no side had side by side get one space, except in scripts written without spaces.",
  // Shape: a merged block the schema cannot hold as it is
  "mark-dropped": "A mark the merged block's type cannot hold is dropped.",
  "inline-moved-out": "An inline node the block cannot hold moves to a new paragraph after it.",
  "stray-inline-wrapped": "Inline content with no paragraph to hold it gets one.",
} as const;

export type RuleName = keyof typeof RULES;

/** How many times each rule fired in one merge. Counts only, no text. */
export type RuleCounts = Partial<Record<RuleName, number>>;

/** What a rule calls when it fires. */
export type Fire = (rule: RuleName, times?: number) => void;

export function ruleCounter(): { counts: RuleCounts; fire: Fire } {
  const counts: RuleCounts = {};
  return {
    counts,
    fire(rule, times = 1) {
      if (times > 0) counts[rule] = (counts[rule] ?? 0) + times;
    },
  };
}

/** Adds one merge's counts to another's. */
export function addCounts(fire: Fire, counts: RuleCounts): void {
  for (const [rule, n] of Object.entries(counts) as [RuleName, number][]) fire(rule, n);
}
