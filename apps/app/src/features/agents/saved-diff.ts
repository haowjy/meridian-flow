/** A file's saved text against its text now, as the rows of a two-column line diff. */
import {
  DIFF_DELETE,
  DIFF_INSERT,
  diffKeys,
  type WordPart,
  wordDiff,
} from "@meridian/agent-edit/diff";

/** One side of a row: its line number and text, with the words that differ when it is paired. */
export interface DiffCell {
  n: number;
  text: string;
  ending: "LF" | "CRLF" | "none";
  empty: boolean;
  /** Runs of the line, `changed` on the words the other side lacks; absent for a whole-line change. */
  runs?: Array<{ text: string; changed: boolean }>;
}

export type DiffRow =
  | { kind: "same"; saved: DiffCell; now: DiffCell }
  /** A side is null where the other side's lines have no counterpart. */
  | { kind: "changed"; saved: DiffCell | null; now: DiffCell | null };

const linesOf = (text: string | null): string[] =>
  text === null ? [] : text === "" ? [""] : (text.match(/[^\n]*\n|[^\n]+$/g) ?? []);

const cellOf = (line: string, n: number): DiffCell => {
  const ending = line.endsWith("\r\n") ? "CRLF" : line.endsWith("\n") ? "LF" : "none";
  return {
    n,
    text: line.slice(0, line.length - (ending === "CRLF" ? 2 : ending === "LF" ? 1 : 0)),
    ending,
    empty: line === "",
  };
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
      const left = x === undefined ? null : cellOf(a[x], x + 1);
      const right = y === undefined ? null : cellOf(b[y], y + 1);
      const words = left && right ? wordDiff(left.text, right.text) : [];
      const runsOf = (skip: WordPart["kind"]) =>
        paired
          ? words.flatMap(({ kind, text }) =>
              kind === skip ? [] : [{ text, changed: kind !== "same" }],
            )
          : undefined;
      rows.push({
        kind: "changed",
        saved: left && { ...left, runs: runsOf("added") },
        now: right && { ...right, runs: runsOf("removed") },
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
          saved: cellOf(a[i], i + 1),
          now: cellOf(b[j], j + 1),
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
  if (rows.length === 0) return [];
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
