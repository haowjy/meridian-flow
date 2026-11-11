import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, makeDiff } from "@sanity/diff-match-patch";
import { Slice } from "prosemirror-model";
import type { Block, Span } from "../codec-types.js";
import type { RemovedUnits } from "../ports/model.js";
import type { WordHunk } from "../word-hunks.js";
import type { TextWindow } from "./find.js";

/** A block rewrite decided against the units the room deleted since the model's view. */
export interface RoomRebasedRewrite {
  /** The block the lowering starts from: the view's, less the room's deletions iff `drop`. */
  before: Block;
  /** `before` with the changes that land. */
  after: Block;
  /** Flat text only: where each landed change sits in `before` and in `after`. */
  windows: [TextWindow[], TextWindow[]] | null;
  /** Changes not made. */
  skipped: number;
  /**
   * The view's block must lose the room's deletions before the edit applies: a structural
   * diff anchors on old units, and a deleted one would bring the model's text back around
   * it. Flat text keeps them, so each splice keeps its side of a deleted run.
   */
  drop: boolean;
}

/** One diff token: `key` is its identity, `size` its length in content positions. */
interface Token {
  key: string;
  size: number;
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
 * not made is counted. `placed` is a find's known placement in a flat block.
 *
 * Null when the rule doesn't decide the block: a flat paragraph whose formatting or
 * attributes the model changed is lowered as without a room.
 */
export function withoutRemovedUnits(
  before: Block,
  after: Block,
  removed: readonly RemovedUnits[],
  placed: readonly WordHunk[] | undefined,
): RoomRebasedRewrite | null {
  const size = before.content.size;
  const dead = new Uint8Array(size);
  for (const span of removed) dead.fill(1, span.from, span.to);
  const deadBefore = new Uint32Array(size + 1);
  for (let at = 0; at < size; at += 1) deadBefore[at + 1] = deadBefore[at] + dead[at];
  const deadIn = (from: number, to: number) => deadBefore[to] - deadBefore[from];
  // The block's own edges survive: the block is still there.
  const alive = (unit: number) => unit < 0 || unit >= size || dead[unit] === 0;
  const cutsDeadNode = (from: number, to: number) =>
    removed.some(
      (span) =>
        span.whole && span.from < to && from < span.to && !(from <= span.from && span.to <= to),
    );
  const flat = isFlatText(before) && isFlatText(after);

  /** The model's changes inside base [bLo, bHi) and model [tLo, tHi), by token diff. */
  const diffed = (bLo: number, bHi: number, tLo: number, tHi: number): Hunk[] => {
    const a = tokens(before.cut(bLo, bHi));
    const b = tokens(after.cut(tLo, tHi));
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
                ? a.slice(p, aFrom).every((t, i) => t.key === b[bTo + shift + i].key)
                : a.slice(aFrom, p).every((t, i) => t.key === b[bFrom + i].key);
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
  if (placed && flat) {
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
  // Formatting moved onto the structural diff lands beside typed-over text by client id
  // (`He **sighed loudly**.`), and splices carry no format ranges.
  if (
    flat &&
    !(
      before.sameMarkup(after) &&
      equal.every(([from, to, at]) =>
        before.content.cut(from, to).eq(after.content.cut(at, at + to - from)),
      )
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
      else if (hunk.at === hunk.end) lands = !cutsDeadNode(hunk.from, hunk.to);
      else lands = deadIn(hunk.from, hunk.to) === 0;
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

  if (flat) {
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
          if (last && last.to === at && last.at === last.end && last.from >= hunk.from)
            last.to += 1;
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
    return { before, after: result, windows, skipped, drop: false };
  }

  // The structural diff's target is the model's block, so its marks and attributes on
  // surviving text land as formatting, with each skipped change put back as the view had
  // it, less the deleted units.
  const base = withoutUnits(before, removed);
  try {
    let result = after;
    for (const hunk of [...hunks].reverse())
      if (!landed.has(hunk))
        result = result.replace(hunk.at, hunk.end, before.slice(hunk.from, hunk.to));
    // Where each deleted unit still in `result` sits in it.
    const cuts: Span[] = [];
    let at = 0;
    let b = 0;
    const keep = (from: number, to: number) => {
      for (let unit = from; unit < to; unit += 1) {
        if (!dead[unit]) continue;
        const pos = at + unit - from;
        const last = cuts.at(-1);
        if (last && last.to === pos) last.to += 1;
        else cuts.push({ from: pos, to: pos + 1 });
      }
      at += to - from;
    };
    for (const hunk of hunks) {
      keep(b, hunk.from);
      if (landed.has(hunk)) at += hunk.end - hunk.at;
      else keep(hunk.from, hunk.to);
      b = hunk.to;
    }
    keep(b, size);
    result = withoutUnits(result, cuts);
    result.check();
    return { before: base, after: result, windows: null, skipped, drop: true };
  } catch {
    // The landed changes don't make a valid block without the skipped ones: make none.
    return { before: base, after: base, windows: null, skipped: Math.max(1, skipped), drop: true };
  }
}

function tokens(node: Block): Token[] {
  const out: Token[] = [];
  const walk = (child: Block) => {
    if (child.isText) {
      // Marks are not part of a token: formatting is not a change of text.
      for (const text of child.text?.match(TOKEN) ?? []) out.push({ key: text, size: text.length });
    } else if (child.isLeaf) {
      out.push({ key: `\u0002${child.type.name}${JSON.stringify(child.attrs)}`, size: 1 });
    } else {
      out.push({ key: `\u0003${child.type.name}${JSON.stringify(child.attrs)}`, size: 1 });
      child.forEach(walk);
      out.push({ key: `\u0004${child.type.name}`, size: 1 });
    }
  };
  node.forEach(walk);
  return out;
}

/** Token-index hunks of a -> b: [aFrom, aTo, bFrom, bTo]. */
function tokenHunks(a: readonly Token[], b: readonly Token[]): [number, number, number, number][] {
  const codes = new Map<string, string>();
  const encode = (list: readonly Token[]) =>
    list
      .map(({ key }) => {
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

function offsets(list: readonly Token[]): number[] {
  const at = [0];
  for (const token of list) at.push((at.at(-1) as number) + token.size);
  return at;
}

/** `node` without the content positions in `spans`, each a run of whole units. */
function withoutUnits(node: Block, spans: readonly Span[]): Block {
  let result = node;
  for (const span of [...spans].reverse())
    if (span.from < span.to) result = result.replace(span.from, span.to, Slice.empty);
  return result;
}
