/**
 * diff-lines — small LCS line-level diff for the AI draft preview overlay.
 *
 * Built for prose, not code: the diff is read as paragraphs with removed text
 * struck through and added text emphasized. No external diff dependency is on
 * the app's manifest yet, so this stays self-contained and small. If a richer
 * diff library lands in `apps/app` later, swap the implementation; the public
 * `DiffOp[]` shape is the seam.
 *
 * Returns `null` when the input pair is too large to diff in memory — the
 * caller falls back to the clean preview rather than freezing the UI on a
 * 1000×1000+ line LCS table.
 */

export type DiffOp = {
  kind: "equal" | "added" | "removed";
  text: string;
};

export type DiffOptions = {
  /** Soft upper bound on `(m+1) * (n+1)` table cells. Default ≈ 1M cells. */
  maxCells?: number;
};

const DEFAULT_MAX_CELLS = 1_000_000;

/**
 * Standard longest-common-subsequence diff over newline-split units.
 *
 * Units are markdown lines (split on `\n`, blank lines preserved). Line-level
 * is the right grain for prose review: paragraph rewrites read as
 * one-removed-many-added blocks rather than character noise.
 *
 * Tokenization: an empty document tokenizes to `[]`, not `[""]` — otherwise
 * `diffLines("", "foo")` would report a phantom blank-line edit before the
 * real change. A single trailing newline is treated as a document terminator,
 * so `"foo"` and `"foo\n"` diff as identical (the writer doesn't see the
 * markdown terminator and shouldn't see a synthetic blank-line op for it).
 */
export function diffLines(a: string, b: string, options?: DiffOptions): DiffOp[] | null {
  const aLines = tokenizeLines(a);
  const bLines = tokenizeLines(b);
  const m = aLines.length;
  const n = bLines.length;
  const maxCells = options?.maxCells ?? DEFAULT_MAX_CELLS;
  if ((m + 1) * (n + 1) > maxCells) return null;

  // LCS length table, filled bottom-right to top-left so we can read the
  // backtrack forward.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) {
        dp[i][j] = dp[i + 1][j + 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (aLines[i] === bLines[j]) {
      ops.push({ kind: "equal", text: aLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "removed", text: aLines[i] });
      i++;
    } else {
      ops.push({ kind: "added", text: bLines[j] });
      j++;
    }
  }
  while (i < m) ops.push({ kind: "removed", text: aLines[i++] });
  while (j < n) ops.push({ kind: "added", text: bLines[j++] });

  return ops;
}

/**
 * Split a document into diff tokens. Empty input is an empty token list (so
 * an empty-doc draft doesn't produce a phantom blank-line edit), and a single
 * terminal newline is stripped so the diff doesn't synthesize trailing
 * blank-line ops for whitespace the writer never sees.
 */
function tokenizeLines(s: string): string[] {
  if (s.length === 0) return [];
  const body = s.endsWith("\n") ? s.slice(0, -1) : s;
  return body.split("\n");
}

/**
 * Collapse adjacent ops of the same kind so the renderer can emit one block
 * per change instead of one element per line. Equal blocks are kept whole;
 * added/removed blocks gain visual weight from being read as a contiguous
 * paragraph.
 */
export type DiffBlock = {
  kind: DiffOp["kind"];
  lines: string[];
};

export function collapseDiffBlocks(ops: DiffOp[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  for (const op of ops) {
    const tail = blocks[blocks.length - 1];
    if (tail && tail.kind === op.kind) {
      tail.lines.push(op.text);
    } else {
      blocks.push({ kind: op.kind, lines: [op.text] });
    }
  }
  return blocks;
}
