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

/** The blocks this lowering handles: one run of text, so a unit is a character. */
export function isFlatTextblock(block: Block): boolean {
  return (
    block.isTextblock &&
    block.type.name !== "code_block" &&
    block.content.size === block.textContent.length
  );
}

/**
 * Lower a block rewrite planned on the model's view into the smallest operations on the
 * units and attributes the model saw, decided against what the room deleted since: an
 * operation whose target is gone is not made and is counted; a delete deletes whatever is
 * left; no deleted unit is put back. `placed` is a find's known placement. Null for a shape
 * this lowering does not handle, which the caller rewrites as a whole block.
 */
export function lowerBlock(
  ctx: { model: AgentEditModel; codec: AgentEditCodec; current?: DocHandle },
  block: BlockRef,
  before: Block,
  after: Block,
  placed: [TextWindow[] | undefined, TextWindow[] | undefined] | null,
): LoweredBlock | null {
  if (!isFlatTextblock(before) || !isFlatTextblock(after)) return null;
  const { model, current } = ctx;
  const ops: EditOp[] = [];
  let skipped = 0;

  const attrs = changedAttrs(ctx.codec, before, after);
  if (Object.keys(attrs).length > 0) {
    if (current && model.roomNodeRemoved(block, [], current)) skipped += 1;
    else ops.push({ kind: "attrs", path: [], attrs });
  }
  if (!before.content.eq(after.content)) {
    const removed = current ? model.roomTextblock(block, [], current) : [];
    const text = lowerText(before, after, removed, placed);
    skipped += text.skipped;
    if (text.splices.length + text.formats.length > 0)
      ops.push({ kind: "text", path: [], splices: text.splices, formats: text.formats });
  }
  return { ops, skipped };
}

/**
 * The attributes the model changed: those where its block differs from what the codec
 * shows of the block it saw. An attribute the codec does not write (an upload in flight)
 * comes back the same from both, so the model never overwrites what it was never shown.
 */
function changedAttrs(codec: AgentEditCodec, before: Block, after: Block): Record<string, unknown> {
  const shown = codec.parse(codec.serialize([before])).blocks[0];
  const changed: Record<string, unknown> = {};
  if (shown)
    for (const [key, value] of Object.entries(after.attrs))
      if (JSON.stringify(value) !== JSON.stringify(shown.attrs[key])) changed[key] = value;
  return changed;
}

interface LoweredText {
  splices: TextSplice[];
  formats: FormatRange[];
  skipped: number;
}

function lowerText(
  before: Block,
  after: Block,
  removed: readonly Span[],
  placed: [TextWindow[] | undefined, TextWindow[] | undefined] | null,
): LoweredText {
  const a = before.textContent;
  const b = after.textContent;
  const size = a.length;
  const dead = new Uint8Array(size);
  for (const span of removed) dead.fill(1, span.from, span.to);
  const deadBefore = new Uint32Array(size + 1);
  for (let at = 0; at < size; at += 1) deadBefore[at + 1] = deadBefore[at] + dead[at];
  const deadIn = (from: number, to: number) => deadBefore[to] - deadBefore[from];
  // The block's own edges survive: the block is still there.
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

  const formats = formatRanges(before, after, hunks);
  const landed = formats.filter(
    (format) => deadIn(format.from, format.to) < format.to - format.from,
  );
  // A range with no surviving unit has nothing to show its mark on: counted, not written.
  skipped += formats.length - landed.length;
  return { splices, formats: landed, skipped };
}

/**
 * Formatting is compared only on text the model left alone, between the hunks; new text
 * carries its own marks inside its splice.
 */
function formatRanges(before: Block, after: Block, hunks: readonly Hunk[]): FormatRange[] {
  const marksA = unitMarks(before);
  const marksB = unitMarks(after);
  const names = new Set<string>();
  for (const marks of [...marksA, ...marksB]) for (const mark of marks) names.add(mark.type.name);
  const value = (marks: readonly Mark[], name: string) => {
    const mark = marks.find((candidate) => candidate.type.name === name);
    return mark ? JSON.stringify(mark.attrs) : null;
  };
  const formats: FormatRange[] = [];
  let base = 0;
  let model = 0;
  for (const hunk of [...hunks, { from: marksA.length, to: marksA.length, at: 0, end: 0 }]) {
    for (const name of names) {
      let open: FormatRange | undefined;
      let want: string | null = null;
      for (let unit = base; unit < hunk.from; unit += 1) {
        const now = value(marksA[unit], name);
        const next = value(marksB[model + unit - base], name);
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
    base = hunk.to;
    model = hunk.end;
  }
  return formats;
}

/** The marks on each character of a flat textblock. */
function unitMarks(block: Block): Array<readonly Mark[]> {
  const marks: Array<readonly Mark[]> = [];
  block.forEach((child) => {
    for (let n = 0; n < (child.text?.length ?? 0); n += 1) marks.push(child.marks);
  });
  return marks;
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
