import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, makeDiff } from "@sanity/diff-match-patch";
import type { Block, Span } from "../codec-types.js";
import type { WordHunk } from "../word-hunks.js";
import type { TextWindow } from "./find.js";

/** A flat block rewrite decided against the units the room deleted since the model's view. */
export interface RoomRebasedRewrite {
  /** The view's block with the changes that land; the room's deletions stay in it. */
  after: Block;
  /** Where each landed change sits in the view's block and in `after`. */
  windows: [TextWindow[], TextWindow[]];
  /** Changes not made. */
  skipped: number;
}

/** A model change: base positions [from, to) become the model's positions [at, end). */
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

/** The lowering's test for a block it rewrites as exact text splices. */
export function isFlatText(block: Block): boolean {
  return (
    block.isTextblock &&
    block.type.name !== "code_block" &&
    block.content.size === block.textContent.length
  );
}

/**
 * Decide a block rewrite planned on the model's view against what the room deleted since.
 * A change lands only if every unit it replaces survives; an insert lands unless it sits in
 * deleted text; a delete deletes whatever is left; no deleted unit is put back; every change
 * not made is counted. `placed` is a find's known placement.
 *
 * Null when the rule doesn't decide the block, which is then lowered as without a room: a
 * block that is not flat text, or one whose formatting or attributes the model changed.
 * Splices carry no format ranges, and a structural diff re-places the model's text beside
 * what the writer typed over.
 */
export function withoutRemovedUnits(
  before: Block,
  after: Block,
  removed: readonly Span[],
  placed: readonly WordHunk[] | undefined,
): RoomRebasedRewrite | null {
  if (!isFlatText(before) || !isFlatText(after)) return null;
  const size = before.content.size;
  const dead = new Uint8Array(size);
  for (const span of removed) dead.fill(1, span.from, span.to);
  const deadBefore = new Uint32Array(size + 1);
  for (let at = 0; at < size; at += 1) deadBefore[at + 1] = deadBefore[at] + dead[at];
  const deadIn = (from: number, to: number) => deadBefore[to] - deadBefore[from];
  // The block's own edges survive: the block is still there.
  const alive = (unit: number) => unit < 0 || unit >= size || dead[unit] === 0;

  /** The model's changes inside base [bLo, bHi) and model [tLo, tHi), by token diff. */
  const diffed = (bLo: number, bHi: number, tLo: number, tHi: number): Hunk[] => {
    // Marks are not part of a token: formatting is not a change of text.
    const a = tokens(before.textContent.slice(bLo, bHi));
    const b = tokens(after.textContent.slice(tLo, tHi));
    const aAt = offsets(a);
    const bAt = offsets(b);
    const raw = tokenHunks(a, b);
    return raw.map(([aFrom, aTo, bFrom, bTo], index) => {
      let moved = 0;
      if (aFrom === aTo) {
        // An insert has no old text, so the diff's place for it is one of several that give
        // the same model text (`A B|X B|C` or `A|B X|B C`). Take the one with the most
        // surviving neighbours, nearest first.
        const lo = raw[index - 1]?.[1] ?? 0;
        const hi = raw[index + 1]?.[0] ?? a.length;
        const score = (p: number) => Number(alive(bLo + aAt[p] - 1)) + Number(alive(bLo + aAt[p]));
        let best = score(aFrom);
        for (let s = 1; s <= bTo - bFrom && best < 2; s += 1) {
          for (const shift of [-s, s]) {
            const p = aFrom + shift;
            if (p < lo || p > hi) continue;
            const same =
              shift < 0
                ? a.slice(p, aFrom).every((t, i) => t === b[bTo + shift + i])
                : a.slice(aFrom, p).every((t, i) => t === b[bFrom + i]);
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
  const hunks: Hunk[] = [];
  if (placed) {
    let shift = 0;
    for (const window of placed) {
      const at = window.from + shift;
      const end = at + window.text.length;
      shift += window.text.length - (window.to - window.from);
      if (deadIn(window.from, window.to) > 0)
        hunks.push(...diffed(window.from, window.to, at, end));
      else
        hunks.push({
          from: window.from,
          to: window.to,
          at,
          end,
          ...(window.from === window.to ? { anchored: true as const } : {}),
        });
    }
  } else hunks.push(...diffed(0, size, 0, after.content.size));

  // Text the model left alone, as [base from, base to, model from].
  const equal: [number, number, number][] = [];
  {
    let b = 0;
    let t = 0;
    for (const hunk of hunks) {
      equal.push([b, hunk.from, t]);
      b = hunk.to;
      t = hunk.end;
    }
    equal.push([b, size, t]);
  }
  if (
    !before.sameMarkup(after) ||
    !equal.every(([from, to, at]) =>
      before.content.cut(from, to).eq(after.content.cut(at, at + to - from)),
    )
  )
    return null;

  let skipped = 0;
  let skipRunEnd = -1;
  const landed = new Set(
    hunks.filter((hunk) => {
      let lands: boolean;
      if (hunk.anchored) lands = alive(hunk.from - 1);
      else if (hunk.from === hunk.to) lands = alive(hunk.from - 1) || alive(hunk.to);
      // A delete deletes whatever is left of its text.
      else lands = hunk.at === hunk.end || deadIn(hunk.from, hunk.to) === 0;
      if (lands) {
        skipRunEnd = -1;
        return true;
      }
      // Skipped changes with nothing but deleted text between them count once.
      const sameRun = skipRunEnd >= 0 && deadIn(skipRunEnd, hunk.from) === hunk.from - skipRunEnd;
      if (!sameRun) skipped += 1;
      skipRunEnd = hunk.to;
      return false;
    }),
  );

  // The landed changes go onto the view's text as it is, deleted units included.
  const pieces: Hunk[] = [];
  for (const hunk of hunks) {
    if (!landed.has(hunk)) continue;
    if (deadIn(hunk.from, hunk.to) === 0) pieces.push(hunk);
    // A delete that also covers deleted units deletes only what is left of it.
    else
      for (let at = hunk.from; at < hunk.to; at += 1) {
        if (dead[at]) continue;
        const last = pieces.at(-1);
        if (last && last.to === at && last.at === last.end && last.from >= hunk.from) last.to += 1;
        else pieces.push({ from: at, to: at + 1, at: hunk.at, end: hunk.at });
      }
  }
  let result = before;
  for (const piece of [...pieces].reverse())
    result = result.replace(piece.from, piece.to, after.slice(piece.at, piece.end));
  const windows: [TextWindow[], TextWindow[]] = [[], []];
  let grown = 0;
  for (const piece of pieces) {
    const length = piece.end - piece.at;
    windows[0].push({ from: piece.from, to: piece.to });
    windows[1].push({ from: piece.from + grown, to: piece.from + grown + length });
    grown += length - (piece.to - piece.from);
  }
  return { after: result, windows, skipped };
}

function tokens(text: string): string[] {
  return text.match(TOKEN) ?? [];
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
