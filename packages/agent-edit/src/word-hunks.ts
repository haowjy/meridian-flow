/** Whole-word differences as offset hunks, for write lowering and identity-gap display. */
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT } from "@sanity/diff-match-patch";
import { wordDiff } from "./diff/tokens.js";

export interface WordHunk {
  from: number;
  to: number;
  text: string;
}

export function wordHunks(before: string, after: string): WordHunk[] {
  const hunks: WordHunk[] = [];
  let offset = 0;
  let current: WordHunk | undefined;
  for (const [op, text] of wordDiff(before, after)) {
    if (op === DIFF_EQUAL) {
      if (current) hunks.push(current);
      current = undefined;
      offset += text.length;
    } else {
      current ??= { from: offset, to: offset, text: "" };
      if (op === DIFF_DELETE) {
        current.to += text.length;
        offset += text.length;
      }
      if (op === DIFF_INSERT) current.text += text;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}
