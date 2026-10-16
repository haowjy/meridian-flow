/**
 * The review projection: one `BlockDiff` read as the changes a writer reviews.
 *
 * Hunks join into a change when only a short run of unchanged words separates them (`CHANGE_MARGIN`,
 * D1), across paragraph breaks. A block removed in one place and added in another pairs as a move and
 * joins both places into one group, so Apply and Discard can never take half of a move. Each group
 * carries a content-derived id, the draft positions the editor decorates, and a short excerpt.
 *
 * The projection reads tokens and (for positions) node sizes only. Unchanged nodes are never touched
 * beyond `nodeSize`, so a caller that retains PM nodes between edits pays for the changed region.
 */
import type { Node as PMNode, Schema } from "prosemirror-model";
import { type ComposeMode, composeHunks, type SpanPatch } from "./compose.js";
import type { BlockDiff, Hunk, HunkKind } from "./hunks.js";
import { hunkKind } from "./hunks.js";
import { blockKey, isBlockTok, isWordTok, type Side, similarity, type Tok } from "./tokens.js";

/** Words of unchanged text that keep two hunks apart; a block start counts as one word. */
export const CHANGE_MARGIN = 3;
/** Share of the shorter block's words a pair must keep, in order, to count as one moved paragraph. */
export const MOVE_SIMILARITY = 0.6;
/** Near-equal move pairing compares every removed block with every added one; past this it keeps exact pairs only. */
const NEAR_PAIR_LIMIT = 40_000;
const EXCERPT_MAX = 120;

export type ProseMirrorJSON = ReturnType<PMNode["toJSON"]>;

export interface BlockSpan {
  from: number;
  to: number;
}
export interface ReviewSpan {
  base: BlockSpan; // top-level block indices in review_base
  draft: BlockSpan; // top-level block indices in the draft
}
export interface ReviewHunk {
  index: number; // position in `projection.diff.hunks`
  baseTokens: { from: number; to: number };
  draftTokens: { from: number; to: number };
  removed: ProseMirrorJSON[]; // base content, drawn as a red widget
  inserted: { from: number; to: number } | null; // positions in the draft doc, drawn green
  anchor: number; // draft position where the red widget sits
  kind: HunkKind;
  /** Unchanged block text that illustrates an attribute-only change, excluding all other hunks. */
  formatContext?: { removed: ProseMirrorJSON[]; inserted: BlockSpan[] };
}
export interface ReviewGroup {
  id: string;
  kind: "change" | "move";
  spans: ReviewSpan[];
  hunks: ReviewHunk[];
  excerpt: { removed: string; inserted: string };
}
export interface ReviewProjection {
  groups: ReviewGroup[]; // draft order
  hasChanges: boolean;
  diff: BlockDiff;
  blockStarts: number[]; // draft position of each top-level block, plus the document size last
}

const isStart = (s: Side, p: number) => p >= s.toks.length || isBlockTok(s.toks[p]);

class Dsu {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number) {
    this.parent[this.find(a)] = this.find(b);
  }
}

export function projectReview(diff: BlockDiff): ReviewProjection {
  const { hunks, base: B, draft: D } = diff;
  const blockStarts = [0];
  let at = 0;
  for (const b of D.blocks) {
    at += b.nodeSize;
    blockStarts.push(at);
  }

  // 1. Clusters: neighbours on the base side separated by fewer than CHANGE_MARGIN unchanged words.
  const dsu = new Dsu(hunks.length);
  for (let i = 1; i < hunks.length; i++) {
    let words = 0;
    for (let p = hunks[i - 1].to; p < hunks[i].from && words < CHANGE_MARGIN; p++)
      if (isBlockTok(B.toks[p]) || isWordTok(B.toks[p])) words++;
    if (words < CHANGE_MARGIN) dsu.union(i - 1, i);
  }
  const clusterOf = hunks.map((_, i) => dsu.find(i));

  // 2. Moves join their two clusters into one group.
  const moved = new Set<number>();
  const groupDsu = new Dsu(hunks.length);
  for (let i = 0; i < hunks.length; i++) groupDsu.union(i, clusterOf[i]);
  for (const [a, b] of pairMoves(diff)) {
    groupDsu.union(a, b);
    moved.add(a);
    moved.add(b);
  }

  // 3. Collect.
  const byGroup = new Map<number, number[]>();
  hunks.forEach((_, i) => {
    const g = groupDsu.find(i);
    const list = byGroup.get(g);
    if (list) list.push(i);
    else byGroup.set(g, [i]);
  });

  const positions = new DraftPositions(D, blockStarts);
  const groups: ReviewGroup[] = [];
  for (const members of byGroup.values()) {
    const contents = members.map((i) => hunkContent(diff, diff.hunks[i]));
    const memo = descend(groupContents, contents);
    memo.value ??= { id: groupHash(diff, members), excerpt: excerpt(diff, members, contents) };
    const rhunks = members.map((i, n) => reviewHunk(diff, i, positions, contents[n]));
    groups.push({
      id: memo.value.id,
      kind: members.some((i) => moved.has(i)) ? "move" : "change",
      spans: groupSpans(diff, members, clusterOf),
      hunks: rhunks,
      excerpt: memo.value.excerpt,
    });
  }
  groups.sort((x, y) => firstDraftToken(diff, x) - firstDraftToken(diff, y));

  // Equal ids (the same edit made twice) take "~n" in document order.
  const seen = new Map<string, number>();
  for (const g of groups) {
    const n = seen.get(g.id) ?? 0;
    seen.set(g.id, n + 1);
    if (n) g.id = `${g.id}~${n}`;
  }
  return { groups, hasChanges: hunks.length > 0, diff, blockStarts };
}

const firstDraftToken = (diff: BlockDiff, g: ReviewGroup) =>
  Math.min(...g.hunks.map((h) => diff.hunks[h.index].sfrom));

/** The patches that apply or discard the groups with these ids; unknown ids are ignored. */
export function composeGroups(
  schema: Schema,
  projection: ReviewProjection,
  ids: Iterable<string>,
  mode: ComposeMode,
): SpanPatch[] {
  const want = new Set(ids);
  const selected: Hunk[] = [];
  for (const g of projection.groups)
    if (want.has(g.id)) for (const h of g.hunks) selected.push(projection.diff.hunks[h.index]);
  return composeHunks(schema, projection.diff, selected, mode);
}

// ---------- moves ----------
interface BlockCandidate {
  hunk: number;
  node: PMNode;
}

/** Whole-block removals and additions, paired exact first, then by in-order word overlap, best first. */
function pairMoves(diff: BlockDiff): Array<[number, number]> {
  const { hunks, base: B, draft: D } = diff;
  const removals: BlockCandidate[] = [];
  const additions: BlockCandidate[] = [];
  // A hunk can hold whole blocks beside other edits (a moved paragraph that lands next to a changed word).
  hunks.forEach((h, i) => {
    for (
      let b = isStart(B, h.from) ? B.blockOf[h.from] : B.blockOf[h.from] + 1;
      B.starts[b + 1] <= h.to;
      b++
    )
      if (b < B.blocks.length && B.starts[b] >= h.from)
        removals.push({ hunk: i, node: B.blocks[b] });
    const endsAtStart = isStart(D, h.sfrom + h.ins.length);
    for (let k = 0; k < h.ins.length; k++) {
      const t = h.ins[k];
      if (!isBlockTok(t)) continue;
      let j = k + 1;
      while (j < h.ins.length && !isBlockTok(h.ins[j])) j++;
      if (j < h.ins.length || endsAtStart)
        additions.push({ hunk: i, node: (t as Tok & { node: PMNode }).node });
    }
  });
  if (!removals.length || !additions.length) return [];

  const pairs: Array<[number, number]> = [];
  const usedR = new Set<number>();
  const usedA = new Set<number>();
  const exact = new Map<string, number[]>();
  removals.forEach((r, i) => {
    const key = blockKey(r.node);
    const q = exact.get(key);
    if (q) q.push(i);
    else exact.set(key, [i]);
  });
  additions.forEach((a, j) => {
    const i = exact.get(blockKey(a.node))?.shift();
    if (i === undefined) return;
    usedR.add(i);
    usedA.add(j);
    if (removals[i].hunk !== a.hunk) pairs.push([removals[i].hunk, a.hunk]);
  });

  const restR = removals.map((_, i) => i).filter((i) => !usedR.has(i));
  const restA = additions.map((_, j) => j).filter((j) => !usedA.has(j));
  if (restR.length * restA.length <= NEAR_PAIR_LIMIT) {
    const scored: Array<{ i: number; j: number; s: number }> = [];
    for (const i of restR)
      for (const j of restA) {
        const s = similarity(removals[i].node, additions[j].node, true, MOVE_SIMILARITY);
        if (s >= MOVE_SIMILARITY) scored.push({ i, j, s });
      }
    scored.sort((x, y) => y.s - x.s);
    for (const { i, j } of scored) {
      if (usedR.has(i) || usedA.has(j)) continue;
      usedR.add(i);
      usedA.add(j);
      if (removals[i].hunk !== additions[j].hunk) pairs.push([removals[i].hunk, additions[j].hunk]);
    }
  }
  return pairs;
}

// ---------- spans ----------
/**
 * Blocks a token range touches. An empty range sits inside a block when the next token is mid-block,
 * continues the previous block when the other side's text starts mid-block, else is a gap between blocks.
 */
function blockSpan(s: Side, from: number, to: number, otherInline: boolean): BlockSpan {
  if (to > from) return { from: s.blockOf[from], to: s.blockOf[to - 1] + 1 };
  if (from < s.toks.length && !isBlockTok(s.toks[from])) {
    const b = s.blockOf[from];
    return { from: b, to: b + 1 };
  }
  const b = from >= s.toks.length ? s.blocks.length : s.blockOf[from];
  return otherInline && b > 0 ? { from: b - 1, to: b } : { from: b, to: b };
}

function groupSpans(diff: BlockDiff, members: number[], clusterOf: number[]): ReviewSpan[] {
  const { hunks, base: B, draft: D } = diff;
  const clusters = new Map<number, number[]>();
  for (const i of members) {
    const c = clusters.get(clusterOf[i]);
    if (c) c.push(i);
    else clusters.set(clusterOf[i], [i]);
  }
  const spans: ReviewSpan[] = [];
  for (const list of clusters.values()) {
    const first = hunks[list[0]];
    const last = hunks[list[list.length - 1]];
    const bFrom = first.from;
    const bTo = last.to;
    const dFrom = first.sfrom;
    const dTo = last.sfrom + last.ins.length;
    const baseInline = bTo > bFrom && !isBlockTok(B.toks[bFrom]);
    const draftInline = dTo > dFrom && !isBlockTok(D.toks[dFrom]);
    spans.push({
      base: blockSpan(B, bFrom, bTo, draftInline),
      draft: blockSpan(D, dFrom, dTo, baseInline),
    });
  }
  spans.sort((a, b) => a.draft.from - b.draft.from || a.base.from - b.base.from);
  // Spans that touch the same block on either side are one span.
  const out: ReviewSpan[] = [];
  const overlaps = (a: BlockSpan, b: BlockSpan) => a.from < b.to && b.from < a.to;
  for (const s of spans) {
    const prev = out.find((p) => overlaps(p.base, s.base) || overlaps(p.draft, s.draft));
    if (prev) {
      prev.base = {
        from: Math.min(prev.base.from, s.base.from),
        to: Math.max(prev.base.to, s.base.to),
      };
      prev.draft = {
        from: Math.min(prev.draft.from, s.draft.from),
        to: Math.max(prev.draft.to, s.draft.to),
      };
    } else out.push({ base: { ...s.base }, draft: { ...s.draft } });
  }
  return out;
}

// ---------- draft positions ----------
const tokenOffsets = new WeakMap<PMNode, Int32Array>();
class DraftPositions {
  constructor(
    private side: Side,
    readonly blockStarts: number[],
  ) {}

  private offsetsOf(b: number): Int32Array {
    let o = tokenOffsets.get(this.side.blocks[b]);
    if (!o) {
      const { toks, starts } = this.side;
      o = new Int32Array(starts[b + 1] - starts[b] + 1);
      let at = 0;
      for (let i = starts[b]; i < starts[b + 1]; i++) {
        o[i - starts[b]] = at;
        at += tokenSize(toks[i]);
      }
      o[o.length - 1] = at;
      tokenOffsets.set(this.side.blocks[b], o);
    }
    return o;
  }

  /** Position where token `p` begins; a block or atom token begins before its block. */
  start(p: number): number {
    const s = this.side;
    const b = s.blockOf[p];
    return s.toks[p].kind === "text" || s.toks[p].kind === "inline"
      ? this.blockStarts[b] + 1 + this.offsetsOf(b)[p - s.starts[b]]
      : this.blockStarts[b];
  }

  /** Position just after token `p`. */
  end(p: number): number {
    const s = this.side;
    const b = s.blockOf[p];
    const t = s.toks[p];
    if (t.kind === "atom") return this.blockStarts[b + 1];
    if (t.kind === "block")
      return s.starts[b + 1] === p + 1 ? this.blockStarts[b + 1] : this.blockStarts[b] + 1;
    return this.blockStarts[b] + 1 + this.offsetsOf(b)[p - s.starts[b]] + tokenSize(t);
  }

  /** Where a removal that left no draft tokens sits. */
  gap(p: number, continuesBlock: boolean): number {
    const s = this.side;
    if (p < s.toks.length && !isBlockTok(s.toks[p])) return this.start(p);
    const b = p >= s.toks.length ? s.blocks.length : s.blockOf[p];
    return continuesBlock && b > 0 ? this.blockStarts[b] - 1 : this.blockStarts[b];
  }
}

const tokenSize = (t: Tok) =>
  t.kind === "text" ? t.ws.length + t.core.length : t.kind === "inline" ? t.node.nodeSize : 0;

// Memo keys retain node identity, never content strings across schemas. Coordinates remain
// global at publication; only position-independent content is shared between frames.
interface ContentMemo<T> {
  next: WeakMap<object, ContentMemo<T>>;
  value?: T;
}
function descend<T>(root: ContentMemo<T>, keys: Iterable<object>): ContentMemo<T> {
  let memo = root;
  for (const key of keys) {
    let child = memo.next.get(key);
    if (!child) {
      child = { next: new WeakMap() };
      memo.next.set(key, child);
    }
    memo = child;
  }
  return memo;
}
type HunkContent = Pick<ReviewHunk, "removed" | "kind"> & {
  context?: { removed: ProseMirrorJSON[]; ranges: Array<BlockSpan & { baseFrom: number }> };
};
const hunkContents: ContentMemo<Map<string, HunkContent>> = { next: new WeakMap() };
const groupContents: ContentMemo<Pick<ReviewGroup, "id" | "excerpt">> = { next: new WeakMap() };
const contentBoundary = {};
function hunkContent(diff: BlockDiff, h: Hunk): HunkContent {
  const keys: object[] = [];
  const range = (side: Side, from: number, to: number) => {
    if (from === to) return "empty";
    const first = side.blockOf[from];
    const last = side.blockOf[to - 1];
    for (let b = first; b <= last; b++) keys.push(side.blocks[b]);
    return `${from - side.starts[first]}:${to - side.starts[last]}`;
  };
  const base = range(diff.base, h.from, h.to);
  keys.push(contentBoundary);
  const draft = range(diff.draft, h.sfrom, h.sfrom + h.ins.length);
  const memo = descend(hunkContents, keys);
  memo.value ??= new Map();
  const ranges = formattingRanges(diff, h);
  const key = `${base}/${draft}/${JSON.stringify(ranges)}`;
  let content = memo.value.get(key);
  if (!content) {
    const tokens = ranges?.flatMap(({ from, to, baseFrom }) =>
      diff.base.toks.slice(h.from + baseFrom, h.from + baseFrom + to - from),
    );
    content = {
      removed: tokensToJSON(diff.base.toks.slice(h.from, h.to)),
      kind: hunkKind(diff.base.toks, h),
      ...(ranges &&
        tokens && {
          context: { removed: tokensToJSON(tokens), ranges },
        }),
    };
    memo.value.set(key, content);
  }
  return content;
}

function reviewHunk(
  diff: BlockDiff,
  index: number,
  pos: DraftPositions,
  content: HunkContent,
): ReviewHunk {
  const h = diff.hunks[index];
  const end = h.sfrom + h.ins.length;
  const inserted = h.ins.length ? { from: pos.start(h.sfrom), to: pos.end(end - 1) } : null;
  const continues = h.to > h.from && !isBlockTok(diff.base.toks[h.from]);
  return {
    index,
    baseTokens: { from: h.from, to: h.to },
    draftTokens: { from: h.sfrom, to: end },
    removed: content.removed,
    inserted,
    anchor: inserted ? inserted.from : pos.gap(h.sfrom, continues),
    kind: content.kind,
    ...(content.context && {
      formatContext: {
        removed: content.context.removed,
        inserted: content.context.ranges.map(({ from, to }) => ({
          from: pos.start(h.sfrom + from),
          to: pos.end(h.sfrom + to - 1),
        })),
      },
    }),
  };
}

// ---------- content ----------
/** Only aligned, unchanged text illustrates block formatting; another hunk owns every gap. */
function formattingRanges(
  diff: BlockDiff,
  h: Hunk,
): Array<BlockSpan & { baseFrom: number }> | undefined {
  if (
    h.to !== h.from + 1 ||
    diff.base.toks[h.from].kind !== "block" ||
    hunkKind(diff.base.toks, h) !== "format"
  )
    return undefined;
  const baseEnd = diff.base.starts[diff.base.blockOf[h.from] + 1];
  const draftEnd = diff.draft.starts[diff.draft.blockOf[h.sfrom] + 1];
  // Relative token ranges keep the memo independent of preceding blocks' positions.
  const ranges = [{ from: 0, to: 1, baseFrom: 0 }];
  for (let b = h.to; b < baseEnd; b++) {
    const d = diff.pos[b];
    if (d <= h.sfrom || d >= draftEnd) continue;
    const offset = d - h.sfrom;
    const baseFrom = b - h.from;
    const last = ranges[ranges.length - 1];
    if (last.to === offset && last.baseFrom + last.to - last.from === baseFrom) last.to++;
    else ranges.push({ from: offset, to: offset + 1, baseFrom });
  }
  // With another edit in this block, paint inline: a whole-node mark would also wrap its red widget.
  if (
    ranges.length !== 1 ||
    ranges[0].to !== baseEnd - h.from ||
    ranges[0].to !== draftEnd - h.sfrom
  ) {
    ranges[0].from++;
    ranges[0].baseFrom++;
    if (ranges[0].from === ranges[0].to) ranges.shift();
  }
  return ranges;
}

function tokensToJSON(toks: readonly Tok[]): ProseMirrorJSON[] {
  const out: ProseMirrorJSON[] = [];
  let block: ProseMirrorJSON | null = null;
  const sink = (): ProseMirrorJSON[] => {
    if (!block) return out;
    block.content ??= [];
    return block.content;
  };
  const text = (value: string, marks: readonly { toJSON(): unknown }[]) => {
    if (!value) return;
    const list = sink();
    const markJson = marks.length ? marks.map((m) => m.toJSON()) : undefined;
    const prev = list.at(-1);
    if (prev?.type === "text" && JSON.stringify(prev.marks) === JSON.stringify(markJson)) {
      prev.text += value;
      return;
    }
    list.push({ type: "text", text: value, ...(markJson ? { marks: markJson } : {}) });
  };
  for (const t of toks) {
    if (t.kind === "block") {
      block = t.node.copy().toJSON();
      out.push(block);
    } else if (t.kind === "atom") {
      block = null;
      out.push(t.node.toJSON());
    } else if (t.kind === "inline") sink().push(t.node.toJSON());
    else {
      if (t.wsMarks) text(t.ws, t.wsMarks);
      else if (t.ws) text(t.ws, t.marks);
      text(t.core, t.marks);
    }
  }
  return out;
}

const plain = (toks: readonly Tok[]) => {
  let s = "";
  for (const t of toks)
    s += t.kind === "text" ? t.ws + t.core : isBlockTok(t) || t.kind === "inline" ? " " : "";
  return s;
};

function excerpt(
  diff: BlockDiff,
  members: number[],
  contents: HunkContent[],
): { removed: string; inserted: string } {
  const clip = (parts: Array<{ at: number; text: string }>) => {
    const s = parts
      .sort((a, b) => a.at - b.at)
      .map(({ text }) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .join(" ");
    return s.length > EXCERPT_MAX ? `${s.slice(0, EXCERPT_MAX - 1).trimEnd()}…` : s;
  };
  const removed: Array<{ at: number; text: string }> = [];
  const inserted: Array<{ at: number; text: string }> = [];
  members.forEach((i, n) => {
    const h = diff.hunks[i];
    const context = contents[n].context;
    if (context) {
      for (const { from, to, baseFrom } of context.ranges) {
        const at = h.from + baseFrom;
        const part = { at, text: plain(diff.base.toks.slice(at, at + to - from)) };
        removed.push(part);
        inserted.push({ at: h.sfrom + from, text: part.text });
      }
    } else {
      removed.push({ at: h.from, text: plain(diff.base.toks.slice(h.from, h.to)) });
      inserted.push({ at: h.sfrom, text: plain(h.ins) });
    }
  });
  return { removed: clip(removed), inserted: clip(inserted) };
}

// ---------- ids ----------
/**
 * A 60-bit content hash of what the group removes and adds, base64url, 10 characters. Positions are
 * left out, so an edit elsewhere keeps the id and an edit inside a hunk changes it. Synchronous
 * because the browser projects on every keystroke; two independent 32-bit mixes (cyrb53's) stand in
 * for sha-256, which would need an async WebCrypto round trip.
 */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function groupHash(diff: BlockDiff, members: number[]): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
  };
  const tok = (t: Tok) => {
    feed(t.key);
    if (t.kind === "text") feed(`\u0003${t.ws}`);
    feed("\u0000");
  };
  for (const i of members) {
    const h = diff.hunks[i];
    for (let p = h.from; p < h.to; p++) tok(diff.base.toks[p]);
    feed("\u0001");
    for (const t of h.ins) tok(t);
    feed("\u0002");
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  let id = "";
  for (let k = 0; k < 5; k++) id += B64[(h1 >>> (6 * k)) & 63];
  for (let k = 0; k < 5; k++) id += B64[(h2 >>> (6 * k)) & 63];
  return id;
}
