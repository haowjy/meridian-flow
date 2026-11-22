/**
 * What one change of an AI edit is in a text now: does it `stand` (the text holds it and it can be
 * taken out cleanly). A read of the edit's recorded content against the text; nothing follows CRDT
 * item ids. The Live turn inverse uses it. See `content-merge.md`.
 */
import type { Node as PMNode, Schema } from "prosemirror-model";
import { applySpanPatches, composeHunks } from "../diff/compose.js";
import { blocksEqual } from "../diff/equal.js";
import { changeGroups } from "../diff/groups.js";
import { diffBlocks } from "../diff/hunks.js";
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

/** The changes of an edit, as if this edit were alone; a moved block is not one. */
export function editChanges(schema: Schema, delta: EditDelta): EditChange[] {
  const diff = diffBlocks(delta.before, delta.after);
  return changeGroups(diff)
    .filter((group) => !group.move)
    .map((group) =>
      narrow(delta.before, applySpanPatches(delta.before, composeHunks(schema, diff, group.hunks))),
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

/** Taking the change out is the merge turned around: `after` is the base, `before` the target. */
const removal = (schema: Schema, change: EditChange, window: readonly PMNode[]) =>
  contentMerge(schema, change.after, change.before, window);

/** The text with the change taken out. Run it only for a change that stands. */
export function takeOut(schema: Schema, change: EditChange, text: readonly PMNode[]): PMNode[] {
  const at = windowIn(change, text);
  return at ? at.put(removal(schema, change, at.blocks).blocks) : [...text];
}

/**
 * The state of a change in the manuscript `text`.
 */
export function changeStateIn(
  schema: Schema,
  change: EditChange,
  text: readonly PMNode[],
): ChangeState {
  return stateIn(schema, change, windowIn(change, text));
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
  // Words the writer typed at the very edge of the change sit on either side of it, and the merge
  // puts the first-named side's insertion first: the change goes back as the text holds it when
  // either side is named first.
  const putBack = (live: readonly PMNode[], draft: readonly PMNode[]) => {
    const back = contentMerge(schema, change.before, live, draft);
    return !back.conflicts.length && blocksEqual(back.blocks, at.blocks);
  };
  return putBack(change.after, inverse.blocks) || putBack(inverse.blocks, change.after)
    ? "stands"
    : "altered";
}

/**
 * `text` with every change of `parts` that stands in it taken out, in order, and the parts that had
 * one: an Undo of an AI write (or a press) by content, read against each part's recorded delta.
 */
export function takeBack<P extends { delta: StoredDelta | null }>(
  schema: Schema,
  text: readonly PMNode[],
  parts: readonly P[],
): { text: readonly PMNode[]; taken: P[] } {
  let blocks = text;
  const taken: P[] = [];
  for (const part of parts) {
    if (!part.delta) continue;
    for (const change of editChanges(schema, readDelta(schema, part.delta))) {
      if (changeStateIn(schema, change, blocks) !== "stands") continue;
      blocks = takeOut(schema, change, blocks);
      if (!taken.includes(part)) taken.push(part);
    }
  }
  return { text: blocks, taken };
}
