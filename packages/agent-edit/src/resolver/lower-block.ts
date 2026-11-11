import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, makeDiff } from "@sanity/diff-match-patch";
import { Fragment, type Mark } from "prosemirror-model";
import type { AgentEditCodec } from "../codec-adapter.js";
import type { Block, Span } from "../codec-types.js";
import type { BlockRef, DocHandle } from "../handles.js";
import type { AgentEditModel, EditOp, FormatRange, TextSplice } from "../ports/model.js";
import { wordHunks } from "../word-hunks.js";
import type { TextWindow } from "./find.js";

export interface LoweredBlock {
  ops: EditOp[];
  /** Operations not made because their target is gone in the room. */
  skipped: number;
}

/** A model change: base units [from, to) become the model's units [at, end). */
interface Hunk {
  /** A find insert, which the model put after its match. */
  anchored?: true;
  from: number;
  to: number;
  at: number;
  end: number;
}

const UNSPACED = "\\p{sc=Han}\\p{sc=Hiragana}\\p{sc=Katakana}";
/**
 * The rule's one text test: a character of Chinese or Japanese script with its marks; a run
 * of any other letters, digits and marks (a word, or a spaceless Thai phrase); a run of
 * whitespace; any other single character.
 */
const TOKEN = new RegExp(
  `[${UNSPACED}]\\p{M}*|(?:(?![${UNSPACED}])[\\p{L}\\p{N}\\p{M}_])+|\\s+|[^]`,
  "gu",
);

/** The pair has a shape the lowering cannot keep: a node was added, removed or retyped. */
class Unsupported extends Error {}

interface Walk {
  codec: AgentEditCodec;
  model: AgentEditModel;
  current: DocHandle | undefined;
  block: BlockRef;
  /** The top-level block as the model saw it. */
  top: Block;
  /** What the codec shows of `top`: the attributes the model could have seen. */
  shown?: Block;
  /** A find's windows as units, by the path of the textblock that holds them. */
  windows: Map<string, [TextWindow[], TextWindow[]]> | null;
  ops: EditOp[];
  skipped: number;
}

/**
 * Lower a block rewrite planned on the model's view into the smallest operations on the
 * units and attributes the model saw, decided against what the room deleted since: an
 * operation whose target is gone is not made and is counted; a delete deletes whatever is
 * left; no deleted unit is put back. Every textblock at any depth is lowered by the same
 * decision. `placed` is a find's windows in the two blocks' text. Null for a shape this
 * lowering does not keep (a node added, removed or retyped, an inline atom put inside a run
 * of text), which the caller rewrites as a whole block.
 */
export function lowerBlock(
  ctx: { model: AgentEditModel; codec: AgentEditCodec; current?: DocHandle },
  block: BlockRef,
  before: Block,
  after: Block,
  placed: [TextWindow[] | undefined, TextWindow[] | undefined] | null,
): LoweredBlock | null {
  if (!sameShape(before, after)) return null;
  const walk: Walk = {
    codec: ctx.codec,
    model: ctx.model,
    current: ctx.current,
    block,
    top: before,
    windows: placed?.[0] && placed[1] ? unitWindows(before, after, placed[0], placed[1]) : null,
    ops: [],
    skipped: 0,
  };
  try {
    lowerNode(walk, before, after, []);
  } catch (cause) {
    if (cause instanceof Unsupported) return null;
    throw cause;
  }
  return { ops: walk.ops, skipped: walk.skipped };
}

function sameShape(before: Block, after: Block): boolean {
  if (before.type !== after.type) return false;
  if (before.isTextblock) return true;
  if (before.childCount !== after.childCount) return false;
  for (let index = 0; index < before.childCount; index += 1)
    if (!sameShape(before.child(index), after.child(index))) return false;
  return true;
}

function lowerNode(walk: Walk, before: Block, after: Block, path: readonly number[]): void {
  if (before.eq(after)) return;
  const ops: EditOp[] = [];
  let skipped = 0;
  const attrs = changedAttrs(before, after, () => shownNode(walk, path));
  if (Object.keys(attrs).length > 0) ops.push({ kind: "attrs", path, attrs });
  if (before.isTextblock) {
    const text = lowerTextblock(walk, before, after, path);
    ops.push(...text.ops);
    skipped += text.skipped;
  }
  // A node the room removed has no target for any change: it counts once.
  if (
    (ops.length > 0 || skipped > 0) &&
    walk.current &&
    walk.model.roomNodeRemoved(walk.block, path, walk.current)
  ) {
    walk.skipped += 1;
    return;
  }
  walk.ops.push(...ops);
  walk.skipped += skipped;
  if (before.isTextblock) return;
  for (let index = 0; index < before.childCount; index += 1)
    lowerNode(walk, before.child(index), after.child(index), [...path, index]);
}

/**
 * The attributes the model changed: those where its node differs from what the codec
 * shows of the node it saw. An attribute the codec does not write (an upload in flight)
 * comes back the same from both, so the model never overwrites what it was never shown.
 */
function changedAttrs(before: Block, after: Block, shownOf: () => Block): Record<string, unknown> {
  const differs = (left: unknown, right: unknown) => JSON.stringify(left) !== JSON.stringify(right);
  const candidates = Object.keys(after.attrs).filter((key) =>
    differs(before.attrs[key], after.attrs[key]),
  );
  const changed: Record<string, unknown> = {};
  if (candidates.length === 0) return changed;
  const shown = shownOf();
  for (const key of candidates)
    if (differs(shown.attrs[key], after.attrs[key])) changed[key] = after.attrs[key];
  return changed;
}

/** The node at `path` in the codec's round trip of the top-level block. */
function shownNode(walk: Walk, path: readonly number[]): Block {
  walk.shown ??= walk.codec.parse(walk.codec.serialize([walk.top])).blocks[0];
  let node: Block | null | undefined = walk.shown;
  for (const index of path) node = node?.maybeChild(index);
  if (!node) throw new Unsupported();
  return node;
}

/** The `ordinal`th inline atom of the textblock at `path` in the codec's round trip. */
function shownAtom(walk: Walk, path: readonly number[], ordinal: number): Block {
  const atoms: Block[] = [];
  shownNode(walk, path).forEach((child) => {
    if (!child.isText) atoms.push(child);
  });
  const atom = atoms[ordinal];
  if (!atom) throw new Unsupported();
  return atom;
}

function lowerTextblock(
  walk: Walk,
  before: Block,
  after: Block,
  path: readonly number[],
): { ops: EditOp[]; skipped: number } {
  const removed = walk.current ? walk.model.roomTextblock(walk.block, path, walk.current) : [];
  const text = lowerText(before, after, removed, walk.windows?.get(path.join("/")));
  const ops: EditOp[] = [];
  let skipped = text.skipped;
  if (text.splices.length + text.formats.length > 0)
    ops.push({ kind: "text", path, splices: text.splices, formats: text.formats });
  // An atom the model kept is one the room may have changed: only the model's attributes go.
  for (const { unit, modelUnit, ordinal } of text.kept) {
    const was = before.nodeAt(unit);
    const now = after.nodeAt(modelUnit);
    if (!was || !now) continue;
    const attrs = changedAttrs(was, now, () => shownAtom(walk, path, ordinal));
    if (Object.keys(attrs).length === 0) continue;
    if (removed.some((span) => unit >= span.from && unit < span.to)) skipped += 1;
    else ops.push({ kind: "attrs", path, attrs, unit });
  }
  return { ops, skipped };
}

interface LoweredText {
  splices: TextSplice[];
  formats: FormatRange[];
  /** Inline atoms the model kept, by unit in the view and in the model's text. */
  kept: Array<{ unit: number; modelUnit: number; ordinal: number }>;
  skipped: number;
}

/**
 * The units of a textblock as a string: its text, and one character per inline atom type,
 * the same on both sides. Atoms compare by type; a changed attribute is a change to the atom.
 * A character no text holds stands for each type, so no text can pass for an atom.
 */
function unitStrings(before: Block, after: Block) {
  const text = before.textContent + after.textContent;
  const codes = new Map<string, string>();
  let next = 0xe000;
  const code = (type: string) => {
    let found = codes.get(type);
    if (!found) {
      do found = String.fromCharCode(next++);
      while (text.includes(found));
      codes.set(type, found);
    }
    return found;
  };
  const units = (block: Block) => {
    let value = "";
    block.forEach((child) => {
      value += child.isText ? child.text : code(child.type.name);
    });
    return value;
  };
  const a = units(before);
  const b = units(after);
  const atoms = new Set(codes.values());
  return { a, b, isAtom: (unit: string, at: number) => atoms.has(unit[at]) };
}

function lowerText(
  before: Block,
  after: Block,
  removed: readonly Span[],
  placed: [TextWindow[], TextWindow[]] | undefined,
): LoweredText {
  const { a, b, isAtom } = unitStrings(before, after);
  const size = a.length;
  const dead = new Uint8Array(size);
  for (const span of removed) dead.fill(1, span.from, span.to);
  const deadBefore = new Uint32Array(size + 1);
  for (let at = 0; at < size; at += 1) deadBefore[at + 1] = deadBefore[at] + dead[at];
  const deadIn = (from: number, to: number) => deadBefore[to] - deadBefore[from];
  // The textblock's own edges survive: a removed node was dealt with by the caller.
  const alive = (unit: number) => unit < 0 || unit >= size || dead[unit] === 0;

  /** The model's changes inside base [bLo, bHi) and model [tLo, tHi), by token diff. */
  const diffed = (bLo: number, bHi: number, tLo: number, tHi: number): Hunk[] => {
    const ta = a.slice(bLo, bHi).match(TOKEN) ?? [];
    const tb = b.slice(tLo, tHi).match(TOKEN) ?? [];
    const aAt = offsets(ta);
    const bAt = offsets(tb);
    const raw = tokenHunks(ta, tb);
    return raw.map(([aFrom, aTo, bFrom, bTo], index) => {
      let moved = 0;
      if (aFrom === aTo) {
        // An insert has no old text, so the diff's place for it is one of several that give
        // the same model text (`A B|X B|C` or `A|B X|B C`). Take the one with the most
        // surviving neighbours, nearest first.
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

  // A find's window is one change, placed by the model; only a window that holds deleted
  // units is split into the changes inside it.
  let hunks: Hunk[] = [];
  const olds = placed?.[0];
  const news = placed?.[1];
  if (olds && news && windowsDescribe(a, b, [olds, news])) {
    for (const [index, old] of olds.entries()) {
      const next = news[index];
      // A cut that rewrites its text unchanged (marks included) is no edit.
      if (
        old.to > old.from &&
        before.content.cut(old.from, old.to).eq(after.content.cut(next.from, next.to))
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
    // No deletion to decide against: the coarser word diff.
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

  // An inline atom is a child of the textblock, not a character of a run of text, so a
  // change that puts one in goes between runs: an insert slides over equal text to the
  // nearest edge; any other is a shape this lowering does not keep.
  const hasAtom = (hunk: Hunk) =>
    [...b.slice(hunk.at, hunk.end)].some((_, i) => isAtom(b, hunk.at + i));
  const midRun = (from: number, to: number) => {
    if (from === 0 || to === size || isAtom(a, from - 1) || isAtom(a, to)) return false;
    for (let at = from; at < to; at += 1) if (isAtom(a, at)) return false;
    return true;
  };
  for (const [index, hunk] of hunks.entries()) {
    if (!hasAtom(hunk) || !midRun(hunk.from, hunk.to)) continue;
    if (hunk.from !== hunk.to || hunk.anchored) throw new Unsupported();
    const floor = hunks[index - 1]?.to ?? 0;
    const ceiling = hunks[index + 1]?.from ?? size;
    let slid = false;
    for (let k = 1; k <= hunk.end - hunk.at && !slid; k += 1) {
      if (
        hunk.from - k >= floor &&
        !midRun(hunk.from - k, hunk.from - k) &&
        a.slice(hunk.from - k, hunk.from) === b.slice(hunk.end - k, hunk.end)
      ) {
        slid = true;
        hunk.from -= k;
        hunk.to -= k;
        hunk.at -= k;
        hunk.end -= k;
      } else if (
        hunk.from + k <= ceiling &&
        !midRun(hunk.from + k, hunk.from + k) &&
        a.slice(hunk.from, hunk.from + k) === b.slice(hunk.at, hunk.at + k)
      ) {
        slid = true;
        hunk.from += k;
        hunk.to += k;
        hunk.at += k;
        hunk.end += k;
      }
    }
    if (!slid) throw new Unsupported();
  }

  let skipped = 0;
  let skipRunEnd = -1;
  const splices: TextSplice[] = [];
  for (const hunk of hunks) {
    let lands: boolean;
    if (hunk.anchored) lands = alive(hunk.from - 1);
    else if (hunk.from === hunk.to) lands = alive(hunk.from - 1) || alive(hunk.to);
    // A replace of deleted text is not made; a delete deletes whatever is left.
    else lands = hunk.at === hunk.end || deadIn(hunk.from, hunk.to) === 0;
    if (!lands) {
      // Skipped changes with nothing but deleted text between them count once.
      const sameRun = skipRunEnd >= 0 && deadIn(skipRunEnd, hunk.from) === hunk.from - skipRunEnd;
      if (!sameRun) skipped += 1;
      skipRunEnd = hunk.to;
      continue;
    }
    skipRunEnd = -1;
    if (deadIn(hunk.from, hunk.to) === 0) {
      splices.push({ from: hunk.from, to: hunk.to, content: after.content.cut(hunk.at, hunk.end) });
      continue;
    }
    // A delete over deleted units deletes only the units left.
    for (let at = hunk.from; at < hunk.to; at += 1) {
      if (dead[at]) continue;
      const last = splices.at(-1);
      if (last && last.to === at && last.from >= hunk.from) last.to += 1;
      else splices.push({ from: at, to: at + 1, content: Fragment.empty });
    }
  }

  const { formats, kept } = keptUnits(before, after, hunks);
  const landed = formats.filter(
    (format) => deadIn(format.from, format.to) < format.to - format.from,
  );
  // A range with no surviving unit has nothing to show its mark on: counted, not written.
  skipped += formats.length - landed.length;
  return { splices, formats: landed, kept, skipped };
}

/**
 * What the model left alone, between the hunks: its formatting changes, compared only there
 * since new text carries its own marks inside its splice, and the inline atoms it kept.
 */
function keptUnits(
  before: Block,
  after: Block,
  hunks: readonly Hunk[],
): { formats: FormatRange[]; kept: LoweredText["kept"] } {
  const marksA = unitMarks(before);
  const marksB = unitMarks(after);
  const names = new Set<string>();
  for (const marks of [...marksA, ...marksB])
    for (const mark of marks ?? []) names.add(mark.type.name);
  const value = (marks: readonly Mark[], name: string) => {
    const mark = marks.find((candidate) => candidate.type.name === name);
    return mark ? JSON.stringify(mark.attrs) : null;
  };
  const formats: FormatRange[] = [];
  const kept: LoweredText["kept"] = [];
  let ordinal = 0;
  let base = 0;
  let model = 0;
  for (const hunk of [...hunks, { from: marksA.length, to: marksA.length, at: 0, end: 0 }]) {
    for (let unit = base; unit < hunk.from; unit += 1)
      if (marksA[unit] === null)
        kept.push({ unit, modelUnit: model + unit - base, ordinal: ordinal++ });
    for (const name of names) {
      let open: FormatRange | undefined;
      let want: string | null = null;
      for (let unit = base; unit < hunk.from; unit += 1) {
        const mine = marksA[unit];
        const theirs = marksB[model + unit - base];
        // An atom carries no marks.
        if (mine === null || theirs === null) {
          open = undefined;
          continue;
        }
        const now = value(mine, name);
        const next = value(theirs, name);
        if (now === next) {
          open = undefined;
        } else if (open && want === next && open.to === unit) {
          open.to = unit + 1;
        } else {
          want = next;
          open = {
            from: unit,
            to: unit + 1,
            mark: name,
            attrs: next === null ? null : (JSON.parse(next) as Record<string, unknown>),
          };
          formats.push(open);
        }
      }
    }
    // Atoms in a hunk are not kept, but they still count in the textblock's order.
    for (let unit = hunk.from; unit < hunk.to; unit += 1) if (marksA[unit] === null) ordinal += 1;
    base = hunk.to;
    model = hunk.end;
  }
  return { formats, kept };
}

/** The marks on each unit of a textblock; null for an inline atom, which carries none. */
function unitMarks(block: Block): Array<readonly Mark[] | null> {
  const marks: Array<readonly Mark[] | null> = [];
  block.forEach((child) => {
    if (child.isText)
      for (let n = 0; n < (child.text?.length ?? 0); n += 1) marks.push(child.marks);
    else marks.push(null);
  });
  return marks;
}

/**
 * A find's windows, given in each block's `textContent`, as unit windows per textblock, by
 * the path of the textblock in the block. Null when the two blocks do not hold the same
 * textblocks or a window crosses one.
 */
function unitWindows(
  before: Block,
  after: Block,
  olds: readonly TextWindow[],
  news: readonly TextWindow[],
): Map<string, [TextWindow[], TextWindow[]]> | null {
  if (olds.length !== news.length) return null;
  const a = textblocksOf(before);
  const b = textblocksOf(after);
  if (a.length !== b.length) return null;
  const placed = new Map<string, [TextWindow[], TextWindow[]]>();
  for (const [index, old] of olds.entries()) {
    const next = news[index];
    // An empty window at a textblock's end belongs to it: an insert goes after its match.
    const at = a.findIndex(
      (candidate) => old.from >= candidate.start && old.to <= candidate.start + candidate.length,
    );
    if (at < 0 || a[at].key !== b[at].key) return null;
    // The model's window sits in the same textblock: the find changed text, not structure.
    if (next.from < b[at].start || next.to > b[at].start + b[at].length) return null;
    const entry = placed.get(a[at].key) ?? [[], []];
    entry[0].push(unitWindow(a[at], old));
    entry[1].push(unitWindow(b[at], next));
    placed.set(a[at].key, entry);
  }
  return placed;
}

interface TextblockText {
  node: Block;
  /** The textblock's path in the block, joined. */
  key: string;
  /** Offset of its first character in the block's `textContent`. */
  start: number;
  length: number;
}

function textblocksOf(block: Block): TextblockText[] {
  const found: TextblockText[] = [];
  let start = 0;
  const visit = (node: Block, path: readonly number[]) => {
    if (node.isTextblock) {
      found.push({ node, key: path.join("/"), start, length: node.textContent.length });
      start += node.textContent.length;
    } else {
      node.forEach((child, _offset, index) => {
        visit(child, [...path, index]);
      });
    }
  };
  visit(block, []);
  return found;
}

/** Text offsets to unit offsets: an inline atom is a unit but no character. */
function unitWindow(textblock: TextblockText, window: TextWindow): TextWindow {
  const unitOf: number[] = [];
  let unit = 0;
  textblock.node.forEach((child) => {
    if (child.isText) for (let n = 0; n < (child.text?.length ?? 0); n += 1) unitOf.push(unit++);
    else unit += 1;
  });
  const from = window.from - textblock.start;
  const to = window.to - textblock.start;
  const after = (char: number) => (char <= 0 ? 0 : unitOf[char - 1] + 1);
  return from === to
    ? { from: after(from), to: after(from) }
    : { from: unitOf[from], to: after(to) };
}

/** Whether the text outside the windows is the same in both blocks, so they place the edit. */
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

/** Token-index hunks of a -> b: [aFrom, aTo, bFrom, bTo]. */
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
          // One UTF-16 unit per distinct token, skipping the surrogate range.
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
