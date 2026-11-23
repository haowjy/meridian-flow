/**
 * What a commit's message says (design §2 and §5): who wrote it, for attribution; for a commit
 * that takes an edit back, what it puts back and which ops it takes back; and for a commit that
 * carries a block's text into another block, which characters it copies. Every commit message is
 * written by `commitMessage` and read by `readCommitMessage`.
 */

/** Who wrote a commit: a chat's turn, or a press. A commit with no author is the writer's own. */
export type CommitAuthor = { turn: string } | { press: string };

/** Ops per peer, as `[from, to)` counters: an edit's in one doc (`TextSpan.ops`). */
export type OpSpans = Record<string, [number, number]>;

/**
 * The characters a take-back commit's inserted characters stand for, in the order it inserted
 * them, as runs `[peer, counter, length]`.
 */
export type StandsFor = [string, number, number][];

/**
 * A take-back (a tab's Undo or Redo, a press's Undo, a draft's return to pending): the character
 * each one it inserts stands for (`deletedBetween`), so text it puts back can be told from typing,
 * whatever it spells; and the ops of the edit it takes back, which count as never made since.
 */
export interface TakeBackNote {
  for: StandsFor;
  ops: OpSpans;
}

/**
 * Text a split or a join carries into another block (design §1): Loro has no move, so the text is
 * new characters, and each one this commit inserts stands for the character of block `from`'s text
 * doc at the same place in `for`. When `from` shows again, its copies go (`removals.ts`).
 */
export interface CopyNote {
  from: string;
  for: StandsFor;
}

export interface CommitNote {
  by?: CommitAuthor;
  undo?: TakeBackNote;
  copy?: CopyNote;
}

/** The message a commit carrying `note` is committed under; none for an empty note. */
export function commitMessage(note: CommitNote): string | undefined {
  if (!note.by && !note.undo && !note.copy) return undefined;
  return JSON.stringify(note);
}

/** What a commit's message says. Messages come from any peer: what is not well formed says nothing. */
export function readCommitMessage(message: string | undefined): CommitNote {
  if (!message?.startsWith("{")) return {};
  let said: unknown;
  try {
    said = JSON.parse(message);
  } catch {
    return {};
  }
  if (!isObject(said)) return {};
  const note: CommitNote = {};
  const by = authorOf(said.by);
  if (by) note.by = by;
  const undo = takeBackOf(said.undo);
  if (undo) note.undo = undo;
  const copy = copyOf(said.copy);
  if (copy) note.copy = copy;
  return note;
}

function authorOf(by: unknown): CommitAuthor | null {
  if (!isObject(by)) return null;
  if (typeof by.turn === "string") return { turn: by.turn };
  if (typeof by.press === "string") return { press: by.press };
  return null;
}

function takeBackOf(undo: unknown): TakeBackNote | null {
  if (!isObject(undo)) return null;
  const { for: runs, ops } = undo;
  if (!isStandsFor(runs) || !isObject(ops) || Array.isArray(ops)) return null;
  for (const span of Object.values(ops))
    if (
      !Array.isArray(span) ||
      span.length !== 2 ||
      !Number.isInteger(span[0]) ||
      !Number.isInteger(span[1])
    )
      return null;
  return { for: runs, ops: ops as OpSpans };
}

function copyOf(copy: unknown): CopyNote | null {
  if (!isObject(copy)) return null;
  const { from, for: runs } = copy;
  return typeof from === "string" && isStandsFor(runs) ? { from, for: runs } : null;
}

const isStandsFor = (runs: unknown): runs is StandsFor =>
  Array.isArray(runs) &&
  runs.every(
    (run) =>
      Array.isArray(run) &&
      run.length === 3 &&
      typeof run[0] === "string" &&
      Number.isInteger(run[1]) &&
      Number.isInteger(run[2]),
  );

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
