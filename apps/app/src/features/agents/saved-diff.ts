/** A file's saved text against its text now, as the rows of a two-column line diff. */
import {
  DIFF_DELETE,
  DIFF_EQUAL,
  DIFF_INSERT,
  diffKeys,
  wordDiff,
} from "@meridian/agent-edit/diff";

/** One side of a row: its line number and text, with the words that differ when it is paired. */
export interface DiffCell {
  n: number;
  text: string;
  /** Runs of the line, `changed` on the words the other side lacks; absent for a whole-line change. */
  runs?: Array<{ text: string; changed: boolean }>;
}

export type DiffRow =
  | { kind: "same"; saved: DiffCell; now: DiffCell }
  /** A side is null where the other side's lines have no counterpart. */
  | { kind: "changed"; saved: DiffCell | null; now: DiffCell | null };

const linesOf = (text: string | null): string[] => {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** `saved` null for an added file, `now` null for a deleted one. */
export function diffRows(saved: string | null, now: string | null): DiffRow[] {
  const a = linesOf(saved);
  const b = linesOf(now);
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  let removed: number[] = [];
  let added: number[] = [];
  // A run of removed lines and the added lines beside it pair up row by row, so an edited line
  // sits beside what it was.
  const flush = () => {
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const x = removed[k];
      const y = added[k];
      const paired = x !== undefined && y !== undefined;
      const words = paired ? wordDiff(a[x], b[y]) : [];
      const runsOf = (skip: number) =>
        paired
          ? words.flatMap(([op, text]) =>
              op === skip ? [] : [{ text, changed: op !== DIFF_EQUAL }],
            )
          : undefined;
      rows.push({
        kind: "changed",
        saved: x === undefined ? null : { n: x + 1, text: a[x], runs: runsOf(DIFF_INSERT) },
        now: y === undefined ? null : { n: y + 1, text: b[y], runs: runsOf(DIFF_DELETE) },
      });
    }
    removed = [];
    added = [];
  };
  for (const [op, count] of diffKeys(a, b)) {
    for (let k = 0; k < count; k++) {
      if (op === DIFF_DELETE) removed.push(i++);
      else if (op === DIFF_INSERT) added.push(j++);
      else {
        flush();
        rows.push({
          kind: "same",
          saved: { n: i + 1, text: a[i] },
          now: { n: j + 1, text: b[j] },
        });
        i++;
        j++;
      }
    }
  }
  flush();
  return rows;
}

/** Unchanged lines kept on each side of a change; a longer unchanged stretch folds. */
export const CONTEXT_LINES = 3;

export type DiffBlock =
  | { kind: "rows"; rows: DiffRow[] }
  | { kind: "fold"; start: number; rows: DiffRow[] };

/**
 * The rows with each unchanged stretch longer than twice the context folded, keyed by its first
 * row so an opened fold stays open. A file with no change folds nothing.
 */
export function foldRows(rows: DiffRow[]): DiffBlock[] {
  if (!rows.some((row) => row.kind === "changed")) return [{ kind: "rows", rows }];
  const blocks: DiffBlock[] = [];
  let k = 0;
  while (k < rows.length) {
    if (rows[k].kind === "changed") {
      const start = k;
      while (k < rows.length && rows[k].kind === "changed") k++;
      blocks.push({ kind: "rows", rows: rows.slice(start, k) });
      continue;
    }
    const start = k;
    while (k < rows.length && rows[k].kind === "same") k++;
    const lead = start === 0 ? 0 : CONTEXT_LINES;
    const tail = k === rows.length ? 0 : CONTEXT_LINES;
    if (k - start <= lead + tail + 1) {
      blocks.push({ kind: "rows", rows: rows.slice(start, k) });
      continue;
    }
    if (lead) blocks.push({ kind: "rows", rows: rows.slice(start, start + lead) });
    blocks.push({ kind: "fold", start: start + lead, rows: rows.slice(start + lead, k - tail) });
    if (tail) blocks.push({ kind: "rows", rows: rows.slice(k - tail, k) });
  }
  return blocks;
}
