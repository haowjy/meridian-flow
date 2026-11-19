/**
 * What one change of an AI edit is in a text now: does it `stand` (the text holds it and it can be
 * taken out cleanly), and which pending changes of Changes does it `sitIn`. Both are reads of the
 * edit's recorded content against the text; nothing follows Yjs item ids. See `content-merge.md`.
 */
import type { Node as PMNode, Schema } from "prosemirror-model";
import { applySpanPatches } from "../diff/compose.js";
import { blocksEqual } from "../diff/equal.js";
import { type BlockDiff, diffBlocks } from "../diff/hunks.js";
import { composeGroups, projectReview, type ReviewProjection } from "../diff/review.js";
import type { Tok } from "../diff/tokens.js";
import { contentMerge } from "./merge.js";

/** The blocks an edit's part changed, before and after, with one unchanged block either side. */
export interface EditDelta {
  before: readonly PMNode[];
  after: readonly PMNode[];
}

/** One change of an edit, cut down to its changed blocks and one unchanged block each side. */
export interface EditChange {
  before: readonly PMNode[];
  after: readonly PMNode[];
}

/** `stands`: the text holds it and it comes out cleanly. `altered`: the text holds it changed. `out`: gone. */
export type ChangeState = "stands" | "altered" | "out";

const idOf = (block: PMNode) => block.attrs.id as string;

/** An edit's delta as stored: ProseMirror JSON. */
export interface StoredDelta {
  before: Record<string, unknown>[];
  after: Record<string, unknown>[];
}

/** What a write did to the text: the blocks it changed, before and after, with one block either side. Null when it changed nothing. */
export function captureDelta(
  before: readonly PMNode[],
  after: readonly PMNode[],
): StoredDelta | null {
  if (blocksEqual(before, after)) return null;
  const cut = narrow(before, after);
  return {
    before: cut.before.map((block) => block.toJSON()),
    after: cut.after.map((block) => block.toJSON()),
  };
}

export function readDelta(schema: Schema, stored: StoredDelta): EditDelta {
  return {
    before: stored.before.map((block) => schema.nodeFromJSON(block)),
    after: stored.after.map((block) => schema.nodeFromJSON(block)),
  };
}

/** The changes of an edit, cut by the rule Changes uses, as if this edit were alone. */
export function editChanges(schema: Schema, delta: EditDelta): EditChange[] {
  const projection = projectReview(diffBlocks(delta.before, delta.after));
  return projection.groups
    .filter((group) => group.kind === "change")
    .map((group) =>
      narrow(
        delta.before,
        applySpanPatches(
          delta.before,
          composeGroups(schema, projection, [group.id], "apply"),
          "base",
        ),
      ),
    );
}

function narrow(before: readonly PMNode[], after: readonly PMNode[]): EditChange {
  let head = 0;
  while (head < before.length && head < after.length && blocksEqual([before[head]], [after[head]]))
    head++;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    blocksEqual([before[before.length - 1 - tail]], [after[after.length - 1 - tail]])
  )
    tail++;
  const from = Math.max(0, head - 1);
  return {
    before: before.slice(from, Math.min(before.length, before.length - tail + 1)),
    after: after.slice(from, Math.min(after.length, after.length - tail + 1)),
  };
}

/** The change's stretch of `text`, found by block id, with one block either side. Null when none of its blocks is left. */
function windowIn(change: EditChange, text: readonly PMNode[]) {
  const ids = new Set([...change.before, ...change.after].map(idOf));
  let lo = -1;
  let hi = -1;
  text.forEach((block, index) => {
    if (!ids.has(idOf(block))) return;
    if (lo < 0) lo = index;
    hi = index;
  });
  if (lo < 0) return null;
  // A block of the change that was joined away has no id left to pair, so the stretch is not
  // known: take the whole text.
  const present = new Set(text.map(idOf));
  const intact = change.after.every((block) => present.has(idOf(block)));
  lo = intact ? Math.max(0, lo - 1) : 0;
  hi = intact ? Math.min(text.length - 1, hi + 1) : text.length - 1;
  return {
    blocks: text.slice(lo, hi + 1),
    put: (blocks: readonly PMNode[]) => [...text.slice(0, lo), ...blocks, ...text.slice(hi + 1)],
  };
}

type Window = NonNullable<ReturnType<typeof windowIn>>;

/** Taking the change out as the pull would turn it around: `after` is the base, `before` the draft. */
const removal = (schema: Schema, change: EditChange, window: readonly PMNode[]) =>
  contentMerge(schema, change.after, change.before, window);

/** The text with the change taken out. Run it only for a change that stands. */
export function takeOut(schema: Schema, change: EditChange, text: readonly PMNode[]): PMNode[] {
  const at = windowIn(change, text);
  return at ? at.put(removal(schema, change, at.blocks).blocks) : [...text];
}

/**
 * The state of a change in a text that has no review base: the manuscript. `stands` is the same
 * rule a draft uses, without the pending-change check a base gives.
 */
export function changeStateIn(
  schema: Schema,
  change: EditChange,
  text: readonly PMNode[],
): ChangeState {
  return stateIn(schema, change, windowIn(change, text));
}

/**
 * Whether going from (`base`, `text`) to (`nextBase`, `nextText`) adds a pending change to Changes:
 * the check an applied change's Undo passes before it writes.
 */
export function addsPendingChange(
  base: readonly PMNode[],
  text: readonly PMNode[],
  nextBase: readonly PMNode[],
  nextText: readonly PMNode[],
): boolean {
  return adds(projectReview(diffBlocks(base, text)), projectReview(diffBlocks(nextBase, nextText)));
}

/**
 * The state of a change in `text` against its review base: what `readChange` reports, for the press
 * that takes it out, which must act on exactly what the card offered.
 */
export function changeState(
  schema: Schema,
  change: EditChange,
  text: readonly PMNode[],
  base: readonly PMNode[],
): ChangeState {
  return readChangeWhole(readDraft(schema, base, text), change).state;
}

/**
 * `stands`: the merge sees something to take out, the text holds the whole change, and putting the
 * change back onto the result gives the text again (the round trip, without which a second press
 * could still change the text).
 */
function stateIn(schema: Schema, change: EditChange, at: Window | null): ChangeState {
  if (!at) return "out";
  const inverse = removal(schema, change, at.blocks);
  if (inverse.conflicts.length) return "altered";
  if (blocksEqual(inverse.blocks, at.blocks)) return "out";
  const forward = contentMerge(schema, change.before, change.after, at.blocks);
  if (!blocksEqual(forward.blocks, at.blocks)) return "out";
  // A change that made the first blocks of an empty text comes out as the empty paragraph a text
  // always keeps, which putting it back would sit beside: nothing to round-trip against.
  if (change.before.length === 0 && inverse.blocks.every((block) => block.content.size === 0))
    return "stands";
  const back = contentMerge(schema, change.before, change.after, inverse.blocks);
  return !back.conflicts.length && blocksEqual(back.blocks, at.blocks) ? "stands" : "altered";
}

/**
 * Whether `change` stands in `text` on its own, which Restore asks of a Discard's change: it may
 * add a pending change back, which is what it is for, so the pending-change test of `readChange`
 * does not apply.
 */
export function standsIn(schema: Schema, change: EditChange, text: readonly PMNode[]): boolean {
  return stateIn(schema, change, windowIn(change, text)) === "stands";
}

/** The words a hunk removed and added, and the same with punctuation. */
type Run = { removed: string[]; inserted: string[]; removedAll: string[]; insertedAll: string[] };
const textOf = (toks: readonly Tok[], words: boolean) =>
  toks.flatMap((tok) => (tok.kind === "text" && (tok.word || !words) ? [tok.core] : []));

function runsOf(diff: BlockDiff, indexes: readonly number[]): Run[] {
  return indexes.map((index) => {
    const hunk = diff.hunks[index];
    const removed = diff.base.toks.slice(hunk.from, hunk.to);
    const inserted = diff.draft.toks.slice(hunk.sfrom, hunk.sto);
    return {
      removed: textOf(removed, true),
      inserted: textOf(inserted, true),
      removedAll: textOf(removed, false),
      insertedAll: textOf(inserted, false),
    };
  });
}

/** At least four in five of `mine`'s words are among `theirs` (each used once). */
function mostlyIn(mine: readonly string[], theirs: readonly string[]): boolean {
  const left = new Map<string, number>();
  for (const word of theirs) left.set(word, (left.get(word) ?? 0) + 1);
  let shared = 0;
  for (const word of mine) {
    const n = left.get(word) ?? 0;
    if (!n) continue;
    left.set(word, n - 1);
    shared++;
  }
  return shared >= Math.ceil(mine.length * 0.8);
}

const hashOf = (group: { id: string }) => group.id.replace(/~\d+$/, "");

/**
 * Positions in `before` that have no partner in `after`, pairing equal hashes in document order (an
 * LCS), so one rename in three paragraphs names the paragraph that went, not always the last.
 */
function unpaired(before: readonly string[], after: readonly string[]): number[] {
  const n = before.length;
  const m = after.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i][j] =
        before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (j < m && before[i] === after[j] && lcs[i][j] === lcs[i + 1][j + 1] + 1) j++;
    else out.push(i);
  }
  return out;
}

/**
 * Where the window's changes sit in the whole list: they must appear there as one run with the same
 * hashes, found exactly once. Anything else (the same edit made twice elsewhere) returns -1 and the
 * caller diffs the whole document.
 */
function locate(reading: Reading, windowed: readonly string[]): number {
  if (!windowed.length) return -1;
  const starts = reading.where.get(windowed[0]) ?? [];
  const fits = starts.filter((at) => windowed.every((hash, i) => hash === reading.hashes[at + i]));
  return fits.length === 1 ? fits[0] : -1;
}

/** One draft read against its review base: the pending changes, diffed once, shared by every change read. */
export interface Reading {
  schema: Schema;
  base: readonly PMNode[];
  text: readonly PMNode[];
  pending: ReviewProjection;
  hashes: string[];
  /** Where each hash sits in `hashes`. */
  where: Map<string, number[]>;
  runs: Run[][];
}

export function readDraft(
  schema: Schema,
  base: readonly PMNode[],
  text: readonly PMNode[],
): Reading {
  const pending = projectReview(diffBlocks(base, text));
  const hashes = pending.groups.map(hashOf);
  const where = new Map<string, number[]>();
  hashes.forEach((hash, index) => {
    const at = where.get(hash);
    if (at) at.push(index);
    else where.set(hash, [index]);
  });
  return {
    schema,
    base,
    text,
    pending,
    hashes,
    where,
    runs: pending.groups.map((group) =>
      runsOf(
        pending.diff,
        group.hunks.map((hunk) => hunk.index),
      ),
    ),
  };
}

/**
 * What a change's read keeps between reads. It is valid while `signature` (the blocks the read
 * looked at) is the same, so a write elsewhere in the document costs a change nothing.
 */
export interface ChangeMemo {
  signature: string;
  state: ChangeState;
  /** The change's own words, which never change. */
  mine: Run[];
  /** The window's pending hashes and the ones forcing the change out removed; null when only the whole document tells. */
  forced: { windowed: string[]; gone: number[]; added: boolean } | "none" | null;
}

export interface ChangeRead {
  state: ChangeState;
  /** Positions in `reading.pending.groups` of the pending changes the change sits in. */
  sitsIn: ReadonlySet<number>;
  memo: ChangeMemo;
}

/**
 * The state of a change, and the pending changes it sits in: those whose id is gone once the change
 * is forced out of the text (the same merge with the sides swapped, so `before` wins where the text
 * was altered). A change's id is a hash of what it removes and adds, so "gone" is "taking this change
 * out would alter it". Equal ids (one rename in three paragraphs) are told apart by position. Joined
 * with the pending changes that hold the change's words, for what the merge cannot pair (a paragraph
 * joined into another, a stray quote mark).
 *
 * The removal is diffed over the change's window only: `base` cut to the blocks that pair with it by
 * id. When those are not one run, or the window's changes cannot be found in the whole list, the
 * whole document is diffed.
 */
export function readChange(
  reading: Reading,
  change: EditChange,
  previous?: ChangeMemo,
): ChangeRead {
  return read(reading, change, previous, true);
}

/** `readChange` that always diffs the whole document: the reference the windowed read must stay inside. */
export function readChangeWhole(reading: Reading, change: EditChange): ChangeRead {
  return read(reading, change, undefined, false);
}

function read(
  reading: Reading,
  change: EditChange,
  previous: ChangeMemo | undefined,
  windowed: boolean,
): ChangeRead {
  const { schema, base, text } = reading;
  const at = windowIn(change, text);
  const cut = at && windowed ? baseCut(base, change, at) : null;
  const signature = JSON.stringify([
    at?.blocks.map((block) => block.toJSON()),
    cut?.map((block) => block.toJSON()),
  ]);
  const memo: ChangeMemo =
    previous?.signature === signature && windowed
      ? previous
      : {
          signature,
          state: stateIn(schema, change, at),
          mine: previous?.mine ?? ownRuns(change),
          forced: at ? forcedOut(reading, change, at, cut) : "none",
        };
  const removed = new Set<number>();
  let added = false;
  if (memo.forced === "none") {
    // nothing to take out
  } else {
    const offset = memo.forced ? locate(reading, memo.forced.windowed) : -1;
    if (memo.forced && offset >= 0) {
      for (const index of memo.forced.gone) removed.add(index + offset);
      added = memo.forced.added;
    } else {
      const whole = wholeRemoval(reading, change, at as Window);
      for (const index of whole.gone) removed.add(index);
      added = whole.added;
    }
  }
  for (const index of holding(reading, change, memo.mine)) removed.add(index);
  // An Undo that would add a pending change takes nothing back: it is not offered.
  return {
    state: memo.state === "stands" && added ? "altered" : memo.state,
    sitsIn: removed,
    memo,
  };
}

/** The blocks of `base` that pair with the window by id, when they are one run whose edges pair. */
function baseCut(
  base: readonly PMNode[],
  change: EditChange,
  at: Window,
): readonly PMNode[] | null {
  const ids = new Set([...at.blocks, ...change.before, ...change.after].map(idOf));
  const paired = base.flatMap((block, index) => (ids.has(idOf(block)) ? [index] : []));
  if (!paired.length) return null;
  const first = paired[0];
  const last = paired[paired.length - 1];
  const baseIds = new Set(base.map(idOf));
  const edgesPair =
    baseIds.has(idOf(at.blocks[0])) && baseIds.has(idOf(at.blocks[at.blocks.length - 1]));
  return last - first === paired.length - 1 && edgesPair ? base.slice(first, last + 1) : null;
}

const forcedBlocks = (schema: Schema, change: EditChange, at: Window) =>
  contentMerge(schema, change.after, at.blocks, change.before).blocks;

function forcedOut(
  reading: Reading,
  change: EditChange,
  at: Window,
  cut: readonly PMNode[] | null,
): ChangeMemo["forced"] {
  const forced = forcedBlocks(reading.schema, change, at);
  if (blocksEqual(forced, at.blocks)) return "none";
  if (!cut) return null;
  const before = projectReview(diffBlocks(cut, at.blocks));
  const after = projectReview(diffBlocks(cut, forced));
  const windowed = before.groups.map(hashOf);
  return {
    windowed,
    gone: unpaired(windowed, after.groups.map(hashOf)),
    added: adds(before, after),
  };
}

/** The pending changes forcing the change out removes, and whether it adds one, diffing the whole document. */
function wholeRemoval(reading: Reading, change: EditChange, at: Window) {
  const forced = forcedBlocks(reading.schema, change, at);
  if (blocksEqual(forced, at.blocks)) return { gone: [] as number[], added: false };
  const after = projectReview(diffBlocks(reading.base, at.put(forced)));
  return {
    gone: unpaired(reading.hashes, after.groups.map(hashOf)),
    added: adds(reading.pending, after),
  };
}

/**
 * Whether `after` has a pending change `before` lacks. A group with no partner by id is the same
 * change when it sits where a group that went sat (a neighbour's change it had merged with got
 * smaller, or the newest of two edits on one word left the older) or holds a group's words; it is
 * new otherwise, or when more groups have no partner than went (a group cut in two).
 */
function adds(before: ReviewProjection, after: ReviewProjection): boolean {
  const gone = unpaired(before.groups.map(hashOf), after.groups.map(hashOf));
  const fresh = unpaired(after.groups.map(hashOf), before.groups.map(hashOf));
  if (fresh.length > gone.length) return true;
  const hunksOf = (projection: ReviewProjection, index: number) =>
    projection.groups[index].hunks.map((hunk) => projection.diff.hunks[hunk.index]);
  const runs = (projection: ReviewProjection, index: number) =>
    runsOf(
      projection.diff,
      projection.groups[index].hunks.map((hunk) => hunk.index),
    );
  return fresh.some((index) => {
    const mine = hunksOf(after, index);
    const from = Math.min(...mine.map((h) => h.from));
    const to = Math.max(...mine.map((h) => h.to));
    const where = gone.some((other) => {
      const theirs = hunksOf(before, other);
      return (
        from <= Math.max(...theirs.map((h) => h.to)) && Math.min(...theirs.map((h) => h.from)) <= to
      );
    });
    if (where) return false;
    const words = runs(after, index);
    return !before.groups.some((_, other) =>
      words.every((run) =>
        runs(before, other).some(
          (t) =>
            (run.removed.length || run.inserted.length) &&
            (!run.removed.length || mostlyIn(run.removed, t.removed)) &&
            (!run.inserted.length || mostlyIn(run.inserted, t.inserted)),
        ),
      ),
    );
  });
}

function ownRuns(change: EditChange): Run[] {
  const diff = diffBlocks(change.before, change.after);
  return runsOf(
    diff,
    diff.hunks.map((_, index) => index),
  ).filter((run) => run.removed.length || run.inserted.length);
}

/**
 * The pending changes that hold the change's words: one of their hunks removed what the change's
 * hunk removed and added what it added (each side the hunk has). A change with no words (a
 * paragraph split, a stray quote mark) is placed by its blocks, or by its marks being among the ones
 * the change removed or added.
 */
function holding(reading: Reading, change: EditChange, mine: readonly Run[]): number[] {
  const blockIds = new Set(change.after.map(idOf));
  const out: number[] = [];
  reading.pending.groups.forEach((group, index) => {
    const theirs = reading.runs[index];
    const bare = theirs.every((t) => !t.removed.length && !t.inserted.length);
    const holds = bare
      ? group.spans.some((span) =>
          reading.pending.diff.draft.blocks
            .slice(span.draft.from, span.draft.to)
            .some((block) => blockIds.has(idOf(block))),
        ) ||
        theirs.some((t) =>
          mine.some(
            (run) =>
              (t.removedAll.length || t.insertedAll.length) &&
              mostlyIn(t.removedAll, run.removedAll) &&
              mostlyIn(t.insertedAll, run.insertedAll),
          ),
        )
      : mine.some((run) =>
          theirs.some(
            (t) =>
              (!run.removed.length || mostlyIn(run.removed, t.removed)) &&
              (!run.inserted.length || mostlyIn(run.inserted, t.inserted)),
          ),
        );
    if (holds) out.push(index);
  });
  return out;
}
