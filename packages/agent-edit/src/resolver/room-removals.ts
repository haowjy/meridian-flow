import { Slice } from "prosemirror-model";
import type { Block, Span } from "../codec-types.js";
import type { RemovedUnits } from "../ports/model.js";
import { type WordHunk, wordHunks } from "../word-hunks.js";
import type { TextWindow } from "./find.js";

/** A block rewrite lowered without the units the room deleted since the model's view. */
export interface RoomRebasedRewrite {
  /** The view's block without any of them: what the room holds, less the writer's typing. */
  before: Block;
  /** The model's block without the ones whose delete stands, and without skipped changes. */
  after: Block;
  /** For a flat text block, where the rewrite changes `before` into `after`. */
  windows: [TextWindow[], TextWindow[]] | null;
  /** Changes dropped because the room deleted all of the text they change. */
  skipped: number;
}

/**
 * Rebase a block rewrite planned on the model's view onto the room's deletions. Units are
 * content positions: a character, an inline atom, or a nested node's open and close token.
 * `placed` is the rewrite's known placement (a find's windows) in a flat text block;
 * otherwise the rewrite is word-diffed, and so is a known change that also covers deleted
 * text, inside its window.
 *
 * The writer's delete stands. A change whose old text the room deleted entirely is skipped:
 * it has no target. An insert lands where it was, at the edge of a deleted run, and brings
 * nothing back; so does a change to surviving text only. A change to both lands, and gets
 * back only what keeps its own words whole.
 */
export function withoutRemovedUnits(
  before: Block,
  after: Block,
  removed: readonly RemovedUnits[],
  placed: readonly WordHunk[] | undefined,
): RoomRebasedRewrite {
  const old = unitText(before);
  const next = unitText(after);
  const flat = old === before.textContent && next === after.textContent;
  const gone = new Uint8Array(old.length);
  // Each unit of a deleted node maps to its span, so a change takes it whole or not at all.
  const node = new Int32Array(old.length).fill(-1);
  for (const [index, span] of removed.entries()) {
    gone.fill(1, span.from, span.to);
    if (span.whole) node.fill(index, span.from, span.to);
  }
  const isGone = (at: number) => at >= 0 && at < old.length && gone[at] === 1;
  // Deleted units that come back, as the model's text, to keep a change's words whole.
  const restored = new Uint8Array(old.length);
  const hidden = (at: number) => isGone(at) && restored[at] === 0;

  const known = flat ? placed : undefined;
  /**
   * What a change that replaces deleted text needs back to keep its words whole: a deleted
   * node it cuts into, and the one deleted space that kept it off a surviving word. Such a
   * change is word-diffed, so it never ends inside a word.
   */
  const restoreAround = (change: Hunk, lo: number, hi: number) => {
    for (const edge of [change.from, change.to - 1]) {
      const span = removed[node[edge]];
      if (span === undefined) continue;
      for (let at = Math.max(span.from, lo); at < Math.min(span.to, hi); at += 1)
        if (at < change.from || at >= change.to) restored[at] = 1;
    }
    const { from, to } = change;
    const first = change.text[0];
    if (first !== undefined && isWordChar(first) && hidden(from - 1)) {
      let at = from - 1;
      while (at >= lo && hidden(at)) at -= 1;
      if (at >= lo && isWordChar(old[at])) restoreSpace(from - 1, at, -1);
    }
    const last = change.text.at(-1);
    if (last !== undefined && isWordChar(last) && hidden(to)) {
      let at = to;
      while (at < hi && hidden(at)) at += 1;
      if (at < hi && isWordChar(old[at])) restoreSpace(to, at, 1);
    }
  };
  const restoreSpace = (from: number, stop: number, step: 1 | -1) => {
    for (let at = from; at !== stop; at += step)
      if (isSpace(old[at]) && node[at] < 0) {
        restored[at] = 1;
        return;
      }
  };

  // A known change that also covers deleted text is word-diffed inside its window, so the
  // rule above applies per word there too: a find over a whole passage the writer cut part
  // of keeps that part cut.
  const hunks: (WordHunk & { diffed?: true })[] = known
    ? known.flatMap((hunk) => {
        let deleted = 0;
        for (let at = hunk.from; at < hunk.to; at += 1) deleted += gone[at];
        if (deleted === 0 || deleted === hunk.to - hunk.from) return [hunk];
        return wordHunks(old.slice(hunk.from, hunk.to), hunk.text).map((inner) => ({
          from: hunk.from + inner.from,
          to: hunk.from + inner.to,
          text: inner.text,
          diffed: true as const,
        }));
      })
    : wordHunks(old, next).map((hunk) => ({ ...hunk, diffed: true as const }));
  const final: Hunk[] = [];
  let skipped = 0;
  let shift = 0;
  for (const [index, hunk] of hunks.entries()) {
    const lo = final.at(-1)?.to ?? 0;
    const hi = hunks[index + 1]?.from ?? old.length;
    const { diffed, ...placed } = hunk;
    let change: Hunk = { ...placed, at: hunk.from + shift, drop: false };
    shift += hunk.text.length - (hunk.to - hunk.from);
    if (change.from === change.to) {
      if (diffed && (isGone(change.from - 1) || isGone(change.from)))
        change = slide(old, change, lo, hi, isGone);
      // Inside a deleted node there is nowhere for it to go.
      const inNode = change.from > 0 && node[change.from - 1] >= 0;
      const drop = inNode && node[change.from - 1] === node[change.from];
      if (drop) skipped += 1;
      final.push({ ...change, drop });
      continue;
    }
    let deleted = 0;
    for (let at = change.from; at < change.to; at += 1) deleted += gone[at];
    if (deleted === change.to - change.from) {
      skipped += 1;
      final.push({ ...change, drop: true });
      continue;
    }
    // Only a change that also replaces deleted text gets any of it back.
    if (deleted > 0) restoreAround(change, lo, hi);
    final.push(change);
  }
  if (old.length + shift !== next.length)
    throw new Error("A block rewrite's hunks don't produce its new text");

  // The model's block loses what stays deleted: units of the equal text the room deleted,
  // and the text of skipped changes.
  const cut: Span[] = [];
  const cutAt = (from: number, to: number) => {
    if (from === to) return;
    const last = cut.at(-1);
    if (last && last.to === from) last.to = to;
    else cut.push({ from, to });
  };
  let cursor = 0;
  let offset = 0;
  const equal = (to: number) => {
    for (; cursor < to; cursor += 1)
      if (hidden(cursor)) cutAt(cursor + offset, cursor + offset + 1);
  };
  for (const change of final) {
    equal(change.from);
    if (change.drop) cutAt(change.at, change.at + change.text.length);
    cursor = change.to;
    offset = change.at + change.text.length - change.to;
  }
  equal(old.length);

  return {
    before: withoutUnits(before, removed),
    after: withoutUnits(after, cut),
    windows: flat ? windowsOf(final, old.length, removed, next.length, cut, restored) : null,
    skipped,
  };
}

interface Hunk extends WordHunk {
  /** Where `text` starts in the model's block. */
  at: number;
  /** Skipped: its old text is all deleted. */
  drop: boolean;
}

/**
 * Where each kept change sits in the rebased blocks, as text windows of each. A window of
 * the model's block takes in the units restored beside its change, which `before` lacks.
 */
function windowsOf(
  final: readonly Hunk[],
  oldLength: number,
  removed: readonly Span[],
  nextLength: number,
  cut: readonly Span[],
  restored: Uint8Array,
): [TextWindow[], TextWindow[]] {
  const goneBefore = prefixCounts(oldLength, removed);
  const cutBefore = prefixCounts(nextLength, cut);
  const inRemoved = new Uint8Array(oldLength);
  for (const span of removed) inRemoved.fill(1, span.from, span.to);
  const windows: [TextWindow[], TextWindow[]] = [[], []];
  for (const [index, change] of final.entries()) {
    if (change.drop) continue;
    const lo = final[index - 1]?.to ?? 0;
    const hi = final[index + 1]?.from ?? oldLength;
    let left = 0;
    for (let at = change.from - 1; at >= lo && inRemoved[at]; at -= 1) left += restored[at];
    let right = 0;
    for (let at = change.to; at < hi && inRemoved[at]; at += 1) right += restored[at];
    const end = change.at + change.text.length;
    windows[0].push({
      from: change.from - goneBefore[change.from],
      to: change.to - goneBefore[change.to],
    });
    windows[1].push({
      from: change.at - cutBefore[change.at] - left,
      to: end - cutBefore[end] + right,
    });
  }
  return windows;
}

/**
 * The text-equal place for an insert that best keeps it whole: with its edges on word
 * boundaries against the text that survives around it, then outside any deleted run, then
 * nearest.
 */
function slide(
  old: string,
  hunk: Hunk,
  lo: number,
  hi: number,
  isGone: (at: number) => boolean,
): Hunk {
  const { text } = hunk;
  const rank = (at: number, moved: string) => {
    let left = at - 1;
    while (isGone(left)) left -= 1;
    let right = at;
    while (isGone(right)) right += 1;
    const edges = edgeScore(old[left], moved[0]) + edgeScore(moved.at(-1), old[right]);
    return edges * 2 + (isGone(at - 1) && isGone(at) ? 0 : 1);
  };
  let best = { hunk, rank: rank(hunk.from, text) };
  const consider = (at: number, moved: string) => {
    const value = rank(at, moved);
    if (value > best.rank)
      best = {
        hunk: { ...hunk, from: at, to: at, at: hunk.at + at - hunk.from, text: moved },
        rank: value,
      };
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
  return joins(before, after) ? 0 : 1;
}

/**
 * Two characters are one word only in a script that separates words with spaces: Chinese,
 * Japanese and Thai characters stand alone, and punctuation, dashes and quotes never join.
 */
function joins(left: string, right: string): boolean {
  return isWordChar(left) && isWordChar(right);
}

function isWordChar(char: string): boolean {
  return WORD_CHAR.test(char) && !UNSPACED_SCRIPT.test(char);
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;

function isSpace(char: string): boolean {
  return /\s/u.test(char);
}

/** `counts[i]`: how many units before offset `i` the spans cover. */
function prefixCounts(length: number, spans: readonly Span[]): Uint32Array {
  const counts = new Uint32Array(length + 1);
  const inSpan = new Uint8Array(length);
  for (const span of spans) inSpan.fill(1, span.from, span.to);
  for (let at = 0; at < length; at += 1) counts[at + 1] = counts[at] + inSpan[at];
  return counts;
}

/**
 * A block's content as one character per content position: text as itself, an inline atom
 * as U+FFFC, and a nested node's open and close tokens as two private-use characters.
 */
function unitText(block: Block): string {
  let text = "";
  const walk = (node: Block) => {
    if (node.isText) text += node.text ?? "";
    else if (node.isLeaf) text += "￼";
    else {
      text += "";
      node.forEach(walk);
      text += "";
    }
  };
  block.forEach(walk);
  return text;
}

/** `node` without the content positions in `spans`, each a run of whole units. */
function withoutUnits(node: Block, spans: readonly Span[]): Block {
  let result = node;
  for (const span of [...spans].reverse())
    if (span.from < span.to) result = result.replace(span.from, span.to, Slice.empty);
  return result;
}
