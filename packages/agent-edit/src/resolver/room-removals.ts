import { Slice } from "prosemirror-model";
import type { Block, Span } from "../codec-types.js";
import { type WordHunk, wordHunks } from "../word-hunks.js";
import type { TextWindow } from "./find.js";

/** A block rewrite lowered without the characters the room deleted since the model's view. */
export interface RoomRebasedRewrite {
  /** The view's block without any of them: what the view holds once they are dropped. */
  before: Block;
  /** The model's block without the ones whose delete stands. */
  after: Block;
  /** Where the rewrite changes `before` into `after`, as text windows of each. */
  windows: [TextWindow[], TextWindow[]];
}

/**
 * Rebase a block rewrite planned on the model's view onto the room's deletions, so the
 * lowering never keeps a character the room deleted: one it kept loses the model's text
 * anchored to it. `hunks` are the rewrite's known placement (a find's windows); without
 * them the rewrite is word-diffed.
 *
 * A deleted run stays deleted, as the writer meant, unless the model's inserted text sits
 * inside it, continues into it within a word, or would lose the only space before the next
 * word: dropping it would split or fuse the model's text. A diff-placed insert is first
 * slid along equal text to the best word boundary outside any run
 * (`A disciple. DRAFT-|B2. DRAFT-|B line.` becomes `A disciple.| DRAFT-B2.| DRAFT-B line.`);
 * a run it still touches that way is restated as the model's text.
 */
export function withoutRemovedText(
  before: Block,
  after: Block,
  removed: readonly Span[],
  hunks: readonly WordHunk[] | undefined,
): RoomRebasedRewrite {
  const old = before.textContent;
  const gone = new Uint8Array(old.length);
  for (const span of removed) gone.fill(1, span.from, span.to);
  const placed = hunks !== undefined;
  const pending = hunks ? [...hunks] : wordHunks(old, after.textContent);
  const covered = new Uint8Array(old.length);
  for (const hunk of pending) covered.fill(1, hunk.from, hunk.to);
  const keptGone = (at: number) =>
    at >= 0 && at < old.length && gone[at] === 1 && covered[at] === 0;
  const alive = (at: number) => at >= 0 && at < old.length && gone[at] === 0 && covered[at] === 0;
  // The model's text and a deleted run beside it would part: the run continues the model's
  // word, or held the only space between it and the next surviving word.
  const joinsLeft = (hunk: WordHunk) => {
    if (hunk.text.length === 0 || !keptGone(hunk.from - 1) || isSpace(hunk.text[0])) return false;
    if (!isSpace(old[hunk.from - 1])) return true;
    let start = hunk.from;
    while (keptGone(start - 1)) start -= 1;
    return alive(start - 1) && !isSpace(old[start - 1]);
  };
  const joinsRight = (hunk: WordHunk) => {
    const last = hunk.text[hunk.text.length - 1];
    if (last === undefined || !keptGone(hunk.to) || isSpace(last)) return false;
    if (!isSpace(old[hunk.to])) return true;
    let end = hunk.to;
    while (keptGone(end)) end += 1;
    return alive(end) && !isSpace(old[end]);
  };
  // Inside a deleted run: the model rewrote text someone deleted around it.
  const inside = (hunk: WordHunk) => keptGone(hunk.from - 1) && keptGone(hunk.to);
  const joins = (hunk: WordHunk) =>
    hunk.text.length > 0 && (inside(hunk) || joinsLeft(hunk) || joinsRight(hunk));

  const final: WordHunk[] = [];
  for (const [index, next] of pending.entries()) {
    const lo = final.at(-1)?.to ?? 0;
    const hi = pending[index + 1]?.from ?? old.length;
    let hunk = next;
    if (!placed && hunk.from === hunk.to && joins(hunk)) hunk = slide(old, hunk, lo, hi, inside);
    let { from, to, text } = hunk;
    const within = hunk.text.length > 0 && inside(hunk);
    if (within || joinsLeft(hunk)) {
      while (from > lo && keptGone(from - 1)) from -= 1;
      text = old.slice(from, hunk.from) + text;
    }
    if (within || joinsRight(hunk)) {
      while (to < hi && keptGone(to)) to += 1;
      text += old.slice(hunk.to, to);
    }
    covered.fill(1, from, to);
    final.push({ from, to, text });
  }

  // Map the rewrite onto `after`: kept characters whose delete stands leave it too.
  const dropped: Span[] = [];
  const drop = (at: number) => {
    const last = dropped.at(-1);
    if (last && last.to === at) last.to += 1;
    else dropped.push({ from: at, to: at + 1 });
  };
  const changed: Span[] = [];
  let next = 0;
  let cursor = 0;
  const keep = (to: number) => {
    for (; cursor < to; cursor += 1, next += 1) if (keptGone(cursor)) drop(next);
  };
  for (const hunk of final) {
    keep(hunk.from);
    changed.push({ from: next, to: next + hunk.text.length });
    next += hunk.text.length;
    cursor = hunk.to;
  }
  keep(old.length);
  if (next !== after.textContent.length)
    throw new Error("A block rewrite's hunks don't produce its new text");

  const goneBefore = prefixCounts(old.length, removed);
  const droppedBefore = prefixCounts(next, dropped);
  return {
    before: withoutText(before, removed),
    after: withoutText(after, dropped),
    windows: [
      final.map((hunk) => ({
        from: hunk.from - goneBefore[hunk.from],
        to: hunk.to - goneBefore[hunk.to],
      })),
      changed.map((span) => ({
        from: span.from - droppedBefore[span.from],
        to: span.to - droppedBefore[span.to],
      })),
    ],
  };
}

/**
 * The text-equal place for an insert that best keeps it whole: outside any deleted run,
 * then with its edges on word boundaries, then nearest. Restating happens there.
 */
function slide(
  old: string,
  hunk: WordHunk,
  lo: number,
  hi: number,
  inside: (hunk: WordHunk) => boolean,
): WordHunk {
  const { text } = hunk;
  let best = { hunk, rank: rank(hunk) };
  function rank(candidate: WordHunk): number {
    const score =
      edgeScore(old[candidate.from - 1], candidate.text[0]) +
      edgeScore(candidate.text.at(-1), old[candidate.from]);
    return (inside(candidate) ? 0 : 100) + score;
  }
  const consider = (at: number, moved: string) => {
    const candidate = { from: at, to: at, text: moved };
    const value = rank(candidate);
    if (value > best.rank) best = { hunk: candidate, rank: value };
  };
  for (let shift = 1; shift <= text.length; shift += 1) {
    const left = hunk.from - shift;
    if (left >= lo && old.slice(left, hunk.from) === text.slice(text.length - shift))
      consider(left, text.slice(text.length - shift) + text.slice(0, text.length - shift));
    const right = hunk.to + shift;
    if (right <= hi && old.slice(hunk.to, right) === text.slice(0, shift))
      consider(right, text.slice(shift) + text.slice(0, shift));
  }
  return best.hunk;
}

/** How well a boundary between two characters separates words (edge, space, other, none). */
function edgeScore(before: string | undefined, after: string | undefined): number {
  if (before === undefined || after === undefined) return 3;
  if (isSpace(before) || isSpace(after)) return 2;
  return WORD_CHAR.test(before) && WORD_CHAR.test(after) ? 0 : 1;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;

/** `counts[i]`: how many characters before offset `i` the spans cover. */
function prefixCounts(length: number, spans: readonly Span[]): Uint32Array {
  const counts = new Uint32Array(length + 1);
  const inSpan = new Uint8Array(length);
  for (const span of spans) inSpan.fill(1, span.from, span.to);
  for (let at = 0; at < length; at += 1) counts[at + 1] = counts[at] + inSpan[at];
  return counts;
}

/** `node` without the characters at the given text offsets; its structure stays. */
function withoutText(node: Block, spans: readonly Span[]): Block {
  if (spans.length === 0) return node;
  const cuts: Span[] = [];
  let offset = 0;
  node.descendants((child, pos) => {
    if (!child.isText) return true;
    const length = child.text?.length ?? 0;
    for (const span of spans) {
      const from = Math.max(span.from, offset);
      const to = Math.min(span.to, offset + length);
      if (from < to) cuts.push({ from: pos + from - offset, to: pos + to - offset });
    }
    offset += length;
    return false;
  });
  let result = node;
  for (const cut of cuts.reverse()) result = result.replace(cut.from, cut.to, Slice.empty);
  return result;
}

function isSpace(char: string): boolean {
  return /\s/u.test(char);
}
