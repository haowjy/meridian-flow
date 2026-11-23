/**
 * What a commit's message says (design §2 and §5): who wrote it, for attribution, and, for a commit
 * that takes an edit back, what it puts back and which ops it takes back. Every commit message is
 * written by `commitMessage` and read by `readCommitMessage`.
 */

/** Who wrote a commit: a chat's turn, or a press. A commit with no author is the writer's own. */
export type CommitAuthor = { turn: string } | { press: string };

/** Ops per peer, as `[from, to)` counter spans: an edit's ops in one doc. */
export type OpSpans = Record<string, [number, number][]>;

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

/** A split or join's text in another block, naming the source block and its own delete. */
export interface CopyNote {
  from: string;
  for: StandsFor;
  ops: OpSpans;
}

export interface CommitNote {
  by?: CommitAuthor;
  undo?: TakeBackNote;
  copy?: CopyNote;
  clash?: boolean;
}

/** The message a commit carrying `note` is committed under; none for an empty note. */
export function commitMessage(note: CommitNote): string | undefined {
  if (!note.by && !note.undo) return undefined;
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
  if (said.clash === true) note.clash = true;
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
  if (!Array.isArray(runs) || !isObject(ops) || Array.isArray(ops)) return null;
  for (const run of runs)
    if (
      !Array.isArray(run) ||
      run.length !== 3 ||
      typeof run[0] !== "string" ||
      !Number.isInteger(run[1]) ||
      !Number.isInteger(run[2])
    )
      return null;
  for (const spans of Object.values(ops)) {
    if (!Array.isArray(spans)) return null;
    for (const span of spans)
      if (
        !Array.isArray(span) ||
        span.length !== 2 ||
        !Number.isInteger(span[0]) ||
        !Number.isInteger(span[1])
      )
        return null;
  }
  return { for: runs as StandsFor, ops: ops as OpSpans };
}

function copyOf(copy: unknown): CopyNote | null {
  if (!isObject(copy) || typeof copy.from !== "string") return null;
  const parsed = takeBackOf(copy);
  return parsed ? { from: copy.from, ...parsed } : null;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
