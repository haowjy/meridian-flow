import { commonEnds } from "./common-ends.js";

/** One run of a word-level diff: text both sides share, or text only one side has. */
export interface WordPart {
  kind: "same" | "removed" | "added";
  text: string;
}

const WORDS = /\s+|[^\s]+/g;

/**
 * The words `after` changed from `before`, for Review changes to paint (design §2: word-level
 * diffs are purely visual). Words and the space between them are the units, aligned by longest
 * common subsequence; adjacent runs of one kind merge. Nothing writes from it.
 */
export function wordDiff(before: string, after: string): WordPart[] {
  const a = before.match(WORDS) ?? [];
  const b = after.match(WORDS) ?? [];
  const { start, end } = commonEnds(a, b);
  const midA = a.slice(start, a.length - end);
  const midB = b.slice(start, b.length - end);
  const n = midA.length;
  const m = midB.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: WordPart[] = [];
  const push = (kind: WordPart["kind"], text: string) => {
    const last = out.at(-1);
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  for (const word of a.slice(0, start)) push("same", word);
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      push("same", midA[i++]);
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) push("added", midB[j++]);
    else push("removed", midA[i++]);
  }
  for (const word of a.slice(a.length - end)) push("same", word);
  return out;
}
