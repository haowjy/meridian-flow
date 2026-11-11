// SPIKE (not for merge): one lowering for every block type. A block rewrite becomes the
// smallest operations against the nodes the model saw: text splices and format ranges in a
// text leaf at any depth, attribute sets, and node inserts and deletes under a container.
// The stale-view rule runs once per text leaf, the same wherever the leaf sits.

import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, makeDiff } from "@sanity/diff-match-patch";
import { Fragment, type Mark } from "prosemirror-model";
import type { Block } from "../codec-types.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type {
  AgentEditModel,
  LeafFormat,
  LeafSplice,
  MinimalOp,
  RoomTextblock,
} from "../ports/model.js";
import { wordHunks } from "../word-hunks.js";
import { alignBlocks } from "./block-alignment.js";
import type { TextWindow } from "./find.js";

export interface LoweredBlock {
  ops: MinimalOp[];
  skipped: number;
}

interface Hunk {
  anchored?: true;
  from: number;
  to: number;
  at: number;
  end: number;
}

const UNSPACED = "\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}";
const TOKEN = new RegExp(
  `[${UNSPACED}]\\p{M}*|(?:(?![${UNSPACED}])[\\p{L}\\p{N}\\p{M}_])+|\\s+|[^]`,
  "gu",
);

interface LowerContext {
  model: AgentEditModel;
  block: BlockRef;
  current: DocHandle | undefined;
  /** The textblock being decided. */
  path: readonly number[];
  /** One private-use character per distinct inline atom, shared by both sides of a diff. */
  atoms: Map<string, string>;
  /** An atom as the codec writes it: stored-only attributes are not part of what the model saw. */
  atomKey: (atom: Block) => string;
}

/**
 * Lower `before` (the view's block) rewritten as `after`. `windows` are a find's text windows
 * in the two blocks' `textContent`. Null when a shape isn't lowered by the spike.
 */
export function lowerBlock(
  model: AgentEditModel,
  block: BlockRef,
  current: DocHandle | undefined,
  before: Block,
  after: Block,
  windows: [TextWindow[] | undefined, TextWindow[] | undefined] | null,
  atomKey: (atom: Block) => string,
): LoweredBlock | null {
  const ctx: LowerContext = { model, block, current, path: [], atoms: new Map(), atomKey };
  const placed =
    windows?.[0] && windows[1] ? leafWindows(before, after, windows[0], windows[1]) : null;
  const out: LoweredBlock = { ops: [], skipped: 0 };
  try {
    lowerNode(ctx, before, after, [], placed, { leaf: 0 }, out);
  } catch (cause) {
    if (cause instanceof Unsupported) return null;
    throw cause;
  }
  return out;
}

class Unsupported extends Error {}

/** SPIKE: the real code asks the codec which attributes it serializes. */
const STORED_ONLY_ATTRS = new Set(["uploadToken"]);

function lowerNode(
  ctx: LowerContext,
  before: Block,
  after: Block,
  path: number[],
  placed: Map<number, [TextWindow[], TextWindow[]]> | null,
  counter: { leaf: number },
  out: LoweredBlock,
): void {
  if (before.type !== after.type) throw new Unsupported();
  const state = ctx.current ? ctx.model.roomNodeState(ctx.block, path, ctx.current) : null;

  // An attribute the room changed since the view keeps the room's value.
  const attrs: Record<string, unknown> = {};
  for (const key of Object.keys(after.attrs)) {
    if (JSON.stringify(before.attrs[key]) === JSON.stringify(after.attrs[key])) continue;
    // The codec never writes these, so a reparsed node always lacks them: not the model's change.
    if (STORED_ONLY_ATTRS.has(key)) continue;
    if (state?.removed) out.skipped += 1;
    else if (state && key in state.changed) {
      // The room changed it since the view: its value stands. The same value is no conflict.
      if (JSON.stringify(state.changed[key]) !== JSON.stringify(after.attrs[key] ?? null))
        out.skipped += 1;
    } else attrs[key] = after.attrs[key];
  }
  if (Object.keys(attrs).length > 0) out.ops.push({ kind: "attrs", path, attrs });

  if (before.isTextblock) {
    const leafIndex = counter.leaf++;
    if (before.eq(after) || before.content.eq(after.content)) return;
    const room = ctx.current
      ? ctx.model.roomTextblock(ctx.block, path, ctx.current)
      : { removed: [], added: [] };
    const decided = decideLeaf({ ...ctx, path }, before, after, room, placed?.get(leafIndex));
    out.skipped += decided.skipped;
    if (decided.splices.length + decided.formats.length > 0)
      out.ops.push({ kind: "text", path, splices: decided.splices, formats: decided.formats });
    return;
  }
  if (before.isLeaf) return;

  const olds = childrenOf(before);
  const news = childrenOf(after);
  let last = -1;
  for (const step of alignBlocks(olds, news, (a, b) => a.type === b.type)) {
    switch (step.kind) {
      case "keep":
        countLeaves(olds[step.old], counter);
        last = step.old;
        break;
      case "change":
        lowerNode(ctx, olds[step.old], news[step.next], [...path, step.old], placed, counter, out);
        last = step.old;
        break;
      case "remove":
        // A delete deletes whatever is left: Yjs ignores it where the room already did.
        countLeaves(olds[step.old], counter);
        // A delete deletes what the model saw. Where the room added text inside the node,
        // the node stays and only the view's units go.
        if (ctx.current && ctx.model.roomAddedInside(ctx.block, [...path, step.old], ctx.current))
          emptyTextblocks(ctx, olds[step.old], [...path, step.old], out);
        else out.ops.push({ kind: "delete", path: [...path, step.old] });
        break;
      case "add": {
        if (state?.removed) {
          out.skipped += 1;
          break;
        }
        const previous = out.ops.at(-1);
        if (previous?.kind === "insert" && previous.after === last && samePath(previous.path, path))
          (previous.nodes as Block[]).push(news[step.next]);
        else out.ops.push({ kind: "insert", path, after: last, nodes: [news[step.next]] });
        break;
      }
    }
  }
}

/** Empty the textblocks of a node the model removed; a child the room added nothing to goes. */
function emptyTextblocks(ctx: LowerContext, node: Block, path: number[], out: LoweredBlock): void {
  if (node.isTextblock) {
    if (node.content.size > 0)
      out.ops.push({
        kind: "text",
        path,
        splices: [{ from: 0, to: node.content.size, content: Fragment.empty }],
        formats: [],
      });
    return;
  }
  node.forEach((child, _offset, index) => {
    const at = [...path, index];
    const typedIn =
      ctx.current !== undefined && ctx.model.roomAddedInside(ctx.block, at, ctx.current);
    // The first child stays even when untouched: a list item must open with a paragraph.
    if (typedIn || child.isTextblock || index === 0) emptyTextblocks(ctx, child, at, out);
    else out.ops.push({ kind: "delete", path: at });
  });
}

function samePath(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function childrenOf(node: Block): Block[] {
  const children: Block[] = [];
  node.forEach((child) => {
    children.push(child);
  });
  return children;
}

function countLeaves(node: Block, counter: { leaf: number }): void {
  if (node.isTextblock) counter.leaf += 1;
  else
    node.forEach((child) => {
      countLeaves(child, counter);
    });
}

/** The leaf's units as a string: its text, and one private-use character per inline atom. */
function unitString(ctx: LowerContext, leaf: Block): string {
  let text = "";
  leaf.forEach((child) => {
    if (child.isText) {
      text += child.text ?? "";
      return;
    }
    const key = ctx.atomKey(child);
    let code = ctx.atoms.get(key);
    if (!code) {
      code = String.fromCharCode(0xf000 + ctx.atoms.size);
      ctx.atoms.set(key, code);
    }
    text += code;
  });
  return text;
}

/** Per unit, the marks on it, as `name -> attrs`; an atom has none (Yjs keeps none for it). */
function unitMarks(leaf: Block): Array<readonly Mark[] | null> {
  const marks: Array<readonly Mark[] | null> = [];
  leaf.forEach((child) => {
    if (child.isText)
      for (let n = 0; n < (child.text?.length ?? 0); n += 1) marks.push(child.marks);
    else marks.push(null);
  });
  return marks;
}

interface LeafDecision {
  splices: LeafSplice[];
  formats: LeafFormat[];
  skipped: number;
}

/**
 * The stale-view rule for one text leaf, with formatting as its own operation.
 * Text: a change lands only if every unit it replaces survives; an insert lands unless it
 * sits in deleted text; a delete deletes whatever is left. Format: lands on the surviving
 * units of its range and never ends in deleted text; a range with no surviving unit is skipped.
 */
function decideLeaf(
  ctx: LowerContext,
  before: Block,
  after: Block,
  room: RoomTextblock,
  placed: [TextWindow[], TextWindow[]] | undefined,
): LeafDecision {
  const removed = room.removed;
  const added = new Set(room.added);
  /** The room put text strictly inside [from, to). */
  const addedInside = (from: number, to: number) =>
    room.added.some((boundary) => boundary > from && boundary < to);
  const a = unitString(ctx, before);
  const b = unitString(ctx, after);
  const size = a.length;
  const dead = new Uint8Array(size);
  for (const span of removed) dead.fill(1, span.from, span.to);
  const deadBefore = new Uint32Array(size + 1);
  for (let at = 0; at < size; at += 1) deadBefore[at + 1] = deadBefore[at] + dead[at];
  const deadIn = (from: number, to: number) => deadBefore[to] - deadBefore[from];
  const alive = (unit: number) => unit < 0 || unit >= size || dead[unit] === 0;

  const diffed = (bLo: number, bHi: number, tLo: number, tHi: number): Hunk[] => {
    const ta = a.slice(bLo, bHi).match(TOKEN) ?? [];
    const tb = b.slice(tLo, tHi).match(TOKEN) ?? [];
    const aAt = offsets(ta);
    const bAt = offsets(tb);
    const raw = tokenHunks(ta, tb);
    return raw.map(([aFrom, aTo, bFrom, bTo], index) => {
      let moved = 0;
      if (aFrom === aTo) {
        const lo = raw[index - 1]?.[1] ?? 0;
        const hi = raw[index + 1]?.[0] ?? ta.length;
        const score = (p: number) => Number(alive(bLo + aAt[p] - 1)) + Number(alive(bLo + aAt[p]));
        let best = score(aFrom);
        for (let s = 1; s <= bTo - bFrom && best < 2; s += 1) {
          for (const shift of [-s, s]) {
            const p = aFrom + shift;
            if (p < lo || p > hi) continue;
            const same =
              shift < 0
                ? ta.slice(p, aFrom).every((t, i) => t === tb[bTo + shift + i])
                : ta.slice(aFrom, p).every((t, i) => t === tb[bFrom + i]);
            if (same && score(p) > best) {
              moved = aAt[p] - aAt[aFrom];
              best = score(p);
            }
          }
        }
      }
      return {
        from: bLo + aAt[aFrom] + moved,
        to: bLo + aAt[aTo] + moved,
        at: tLo + bAt[bFrom] + moved,
        end: tLo + bAt[bTo] + moved,
      };
    });
  };

  let hunks: Hunk[] = [];
  const windows = placed && windowsDescribe(a, b, placed) ? placed : undefined;
  if (windows) {
    for (const [index, old] of windows[0].entries()) {
      const next = windows[1][index];
      if (
        before.content.cut(old.from, old.to).eq(after.content.cut(next.from, next.to)) &&
        old.to > old.from
      )
        continue;
      if (deadIn(old.from, old.to) > 0) hunks.push(...diffed(old.from, old.to, next.from, next.to));
      else
        hunks.push({
          from: old.from,
          to: old.to,
          at: next.from,
          end: next.to,
          ...(old.from === old.to ? { anchored: true as const } : {}),
        });
    }
  } else if (removed.length > 0) hunks = diffed(0, size, 0, b.length);
  else {
    // No deletion to decide against: the coarser word diff, as today.
    let shift = 0;
    for (const hunk of wordHunks(a, b)) {
      hunks.push({
        from: hunk.from,
        to: hunk.to,
        at: hunk.from + shift,
        end: hunk.from + shift + hunk.text.length,
      });
      shift += hunk.text.length - (hunk.to - hunk.from);
    }
  }
  hunks = hunks.filter((hunk) => hunk.from < hunk.to || hunk.at < hunk.end);

  // An inline atom is a child of the leaf, not a character of a text run, so an insert that
  // carries one goes between two runs: slide it over equal text to the nearest run edge.
  const isAtom = (char: string | undefined) =>
    char !== undefined && char >= "\uf000" && char <= "\uf8ff";
  const runEdge = (unit: number) =>
    unit === 0 || unit === size || isAtom(a[unit - 1]) || isAtom(a[unit]);
  for (const [index, hunk] of hunks.entries()) {
    if (hunk.from !== hunk.to || hunk.anchored || runEdge(hunk.from)) continue;
    if (![...b.slice(hunk.at, hunk.end)].some(isAtom)) continue;
    const floor = hunks[index - 1]?.to ?? 0;
    const ceiling = hunks[index + 1]?.from ?? size;
    for (let k = 1; k <= hunk.end - hunk.at; k += 1) {
      if (
        hunk.from - k >= floor &&
        runEdge(hunk.from - k) &&
        a.slice(hunk.from - k, hunk.from) === b.slice(hunk.end - k, hunk.end)
      ) {
        hunk.from -= k;
        hunk.to -= k;
        hunk.at -= k;
        hunk.end -= k;
        break;
      }
      if (
        hunk.from + k <= ceiling &&
        runEdge(hunk.from + k) &&
        a.slice(hunk.from, hunk.from + k) === b.slice(hunk.at, hunk.at + k)
      ) {
        hunk.from += k;
        hunk.to += k;
        hunk.at += k;
        hunk.end += k;
        break;
      }
    }
  }

  let skipped = 0;
  let skipRunEnd = -1;
  const splices: LeafSplice[] = [];
  for (const hunk of hunks) {
    let lands: boolean;
    if (hunk.anchored) lands = alive(hunk.from - 1);
    else if (hunk.from === hunk.to) lands = alive(hunk.from - 1) || alive(hunk.to);
    else lands = hunk.at === hunk.end || deadIn(hunk.from, hunk.to) === 0;
    // An insert where the room also put text has no side to take: Yjs would order the two
    // by client id, and the room's text may be the rest of a word (`t` + `ears`).
    if (lands && hunk.from === hunk.to && added.has(hunk.from)) lands = false;
    // A replace of text the writer typed inside would strand their typing beside the new text.
    if (lands && hunk.at < hunk.end && addedInside(hunk.from, hunk.to)) lands = false;
    if (!lands) {
      const sameRun = skipRunEnd >= 0 && deadIn(skipRunEnd, hunk.from) === hunk.from - skipRunEnd;
      if (!sameRun) skipped += 1;
      skipRunEnd = hunk.to;
      continue;
    }
    skipRunEnd = -1;
    const content = after.content.cut(hunk.at, hunk.end);
    if (deadIn(hunk.from, hunk.to) === 0) {
      // A replace has two places to anchor its new text: before the range or after it.
      // Take the one where the room added nothing; with room text at both, it is not made.
      const replaces = hunk.from < hunk.to && content.size > 0;
      const after = replaces && added.has(hunk.to);
      if (after && added.has(hunk.from)) {
        skipped += 1;
        continue;
      }
      // Insert-first carries text only; a replace that carries an atom keeps the default side.
      let textOnly = true;
      content.forEach((node) => {
        if (!node.isText) textOnly = false;
      });
      splices.push({
        from: hunk.from,
        to: hunk.to,
        content,
        ...(after && textOnly ? { insertFirst: true } : {}),
      });
      continue;
    }
    // A delete that also covers deleted units deletes only what is left of it.
    for (let at = hunk.from; at < hunk.to; at += 1) {
      if (dead[at]) continue;
      const last = splices.at(-1);
      if (last && last.to === at && last.content.size === 0 && last.from >= hunk.from) last.to += 1;
      else splices.push({ from: at, to: at + 1, content });
    }
  }

  // Formatting is compared only on text the model left alone; new text carries its own.
  const formats: LeafFormat[] = [];
  const marksA = unitMarks(before);
  const marksB = unitMarks(after);
  const names = new Set<string>();
  for (const marks of [...marksA, ...marksB])
    for (const mark of marks ?? []) names.add(mark.type.name);
  const markValue = (marks: readonly Mark[] | null | undefined, name: string) => {
    const mark = marks?.find((candidate) => candidate.type.name === name);
    return mark ? JSON.stringify(mark.attrs) : null;
  };
  let base = 0;
  let model = 0;
  for (const hunk of [...hunks, { from: size, to: size, at: b.length, end: b.length }]) {
    for (const name of names) {
      let open: LeafFormat | undefined;
      let want: string | null = null;
      for (let unit = base; unit < hunk.from; unit += 1) {
        const mine = marksA[unit];
        const theirs = marksB[model + unit - base];
        const now = mine === null ? null : markValue(mine, name);
        const next = theirs === null ? now : markValue(theirs, name);
        if (mine !== null && now !== next) {
          if (open && want === next && open.to === unit) open.to = unit + 1;
          else {
            open = {
              from: unit,
              to: unit + 1,
              mark: name,
              attrs: next === null ? null : (JSON.parse(next) as Record<string, unknown>),
            };
            want = next;
            formats.push(open);
          }
        } else if (mine !== null) open = undefined;
      }
    }
    base = hunk.to;
    model = hunk.end;
  }
  const landedFormats: LeafFormat[] = [];
  for (const format of formats) {
    let to = format.to;
    while (to > format.from && dead[to - 1]) to -= 1;
    if (to === format.from) skipped += 1;
    else landedFormats.push({ ...format, to });
  }
  return { splices, formats: landedFormats, skipped };
}

/** Whether the text outside the windows is the same in both leaves, so they place the edit. */
function windowsDescribe(
  a: string,
  b: string,
  [olds, news]: [TextWindow[], TextWindow[]],
): boolean {
  if (olds.length !== news.length) return false;
  let oldCursor = 0;
  let newCursor = 0;
  for (const [index, old] of olds.entries()) {
    const next = news[index];
    if (a.slice(oldCursor, old.from) !== b.slice(newCursor, next.from)) return false;
    oldCursor = old.to;
    newCursor = next.to;
  }
  return a.slice(oldCursor) === b.slice(newCursor);
}

/**
 * A find's windows, given in each block's `textContent`, as unit windows per text leaf (by
 * leaf order). Null when the two blocks don't hold the same leaves or a window crosses one.
 */
function leafWindows(
  before: Block,
  after: Block,
  olds: readonly TextWindow[],
  news: readonly TextWindow[],
): Map<number, [TextWindow[], TextWindow[]]> | null {
  if (olds.length !== news.length) return null;
  const a = leavesOf(before);
  const b = leavesOf(after);
  if (a.length !== b.length) return null;
  const placed = new Map<number, [TextWindow[], TextWindow[]]>();
  for (const [index, old] of olds.entries()) {
    const next = news[index];
    const at = locate(a, old);
    if (!at) return null;
    // The model's window sits in the same leaf: the find changed text, not structure.
    const leaf = b[at.leaf];
    if (next.from < leaf.start || next.to > leaf.start + leaf.text) return null;
    const entry = placed.get(at.leaf) ?? [[], []];
    entry[0].push(at.window);
    entry[1].push(unitWindow(leaf, next));
    placed.set(at.leaf, entry);
  }
  return placed;
}

interface LeafText {
  node: Block;
  /** Offset of the leaf's first character in the block's `textContent`. */
  start: number;
  text: number;
}

function leavesOf(block: Block): LeafText[] {
  const leaves: LeafText[] = [];
  let start = 0;
  const visit = (node: Block) => {
    if (node.isTextblock) {
      leaves.push({ node, start, text: node.textContent.length });
      start += node.textContent.length;
    } else node.forEach(visit);
  };
  visit(block);
  return leaves;
}

function locate(
  leaves: readonly LeafText[],
  window: TextWindow,
): { leaf: number; window: TextWindow } | null {
  // An empty window at a leaf's end belongs to that leaf: an insert goes after its match.
  const leaf = leaves.findIndex(
    (candidate) => window.from >= candidate.start && window.to <= candidate.start + candidate.text,
  );
  return leaf < 0 ? null : { leaf, window: unitWindow(leaves[leaf], window) };
}

/** Text offsets to unit offsets: an inline atom is a unit but no character. */
function unitWindow(leaf: LeafText, window: TextWindow): TextWindow {
  const unitOf: number[] = [];
  let unit = 0;
  leaf.node.forEach((child) => {
    if (child.isText) for (let n = 0; n < (child.text?.length ?? 0); n += 1) unitOf.push(unit++);
    else unit += 1;
  });
  const from = window.from - leaf.start;
  const to = window.to - leaf.start;
  const after = (char: number) => (char <= 0 ? 0 : unitOf[char - 1] + 1);
  return from === to
    ? { from: after(from), to: after(from) }
    : { from: unitOf[from], to: after(to) };
}

function tokenHunks(
  a: readonly string[],
  b: readonly string[],
): [number, number, number, number][] {
  const codes = new Map<string, string>();
  const encode = (list: readonly string[]) =>
    list
      .map((key) => {
        let code = codes.get(key);
        if (code === undefined) {
          const index = codes.size + 1;
          const value = index < 0xd800 ? index : index + 0x800;
          if (value > 0xffff) throw new RangeError("Too many distinct tokens");
          code = String.fromCharCode(value);
          codes.set(key, code);
        }
        return code;
      })
      .join("");
  const hunks: [number, number, number, number][] = [];
  let ai = 0;
  let bi = 0;
  let current: [number, number, number, number] | undefined;
  for (const [op, chunk] of makeDiff(encode(a), encode(b))) {
    if (op === DIFF_EQUAL) {
      if (current) hunks.push(current);
      current = undefined;
      ai += chunk.length;
      bi += chunk.length;
      continue;
    }
    current ??= [ai, ai, bi, bi];
    if (op === DIFF_DELETE) {
      ai += chunk.length;
      current[1] = ai;
    }
    if (op === DIFF_INSERT) {
      bi += chunk.length;
      current[3] = bi;
    }
  }
  if (current) hunks.push(current);
  return hunks;
}

function offsets(list: readonly string[]): number[] {
  const at = [0];
  for (const token of list) at.push((at.at(-1) as number) + token.length);
  return at;
}
