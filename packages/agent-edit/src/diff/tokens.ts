/**
 * The token model every diff caller shares: a document's top-level blocks flattened to block starts,
 * words with the whitespace before them, punctuation, inline atoms and whole non-text blocks.
 *
 * A text token's key is its marks and text. Its leading whitespace stays outside the key because it
 * depends on what precedes the token (a split turns " word" into "word"); alignment ignores it and
 * the hunk layer reports a difference only where the same two tokens are neighbours on both sides.
 */
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, makeDiff } from "@sanity/diff-match-patch";
import type { Mark, Node as PMNode, Schema } from "prosemirror-model";

export type Tok =
  | { kind: "block"; key: string; node: PMNode } // start of a textblock; only type, attrs and marks are read
  | { kind: "atom"; key: string; node: PMNode } // a whole non-textblock block (list, table, figure, rule)
  | {
      kind: "text";
      key: string;
      ws: string;
      core: string;
      word: boolean; // a word (letters, digits, marks, underscore), not punctuation
      marks: readonly Mark[];
      wsMarks?: readonly Mark[]; // when the leading space came from a run with other marks
    }
  | { kind: "inline"; key: string; node: PMNode }; // inline atom: image, hard_break

export const isBlockTok = (t: Tok) => t.kind === "block" || t.kind === "atom";
export const isWordTok = (t: Tok) => t.kind === "text" && t.word;
/** Identity ignoring marks and whitespace: a word that only gained a mark stays paired with itself. */
export const coreKey = (t: Tok) => (t.kind === "text" ? `T${t.core}` : t.key);

const keyCache = new WeakMap<PMNode, string>();
const tokCache = new WeakMap<PMNode, Tok[]>();

export function blockKey(node: PMNode): string {
  let key = keyCache.get(node);
  if (key === undefined) {
    key = JSON.stringify(node.toJSON());
    keyCache.set(node, key);
  }
  return key;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
const SPACE = /^\s+$/u;
const marksKey = (marks: readonly Mark[]) =>
  marks.length ? JSON.stringify(marks.map((m) => m.toJSON())) : "";
const sameMarks = (a: readonly Mark[], b: readonly Mark[]) =>
  a.length === b.length && a.every((m, i) => m.eq(b[i]));

export function tokenizeBlock(node: PMNode): Tok[] {
  const cached = tokCache.get(node);
  if (cached) return cached;
  const out: Tok[] = [];
  if (node.isTextblock) {
    out.push({
      kind: "block",
      key: `B${node.type.name}${JSON.stringify(node.attrs)}${marksKey(node.marks)}`,
      node,
    });
    // Whitespace that ends one run leads the next run's first token, so "said **no**" tokenizes like
    // "said no" with a mark on "no". Carry always has one set of marks: a run that starts with its
    // own whitespace flushes the carry as a token of its own first.
    let carry = "";
    let carryMarks: readonly Mark[] = [];
    const flushCarry = () => {
      if (carry)
        out.push({
          kind: "text",
          key: `T${marksKey(carryMarks)}\u0001${carry}`,
          ws: "",
          core: carry,
          word: false,
          marks: carryMarks,
        });
      carry = "";
    };
    node.forEach((child) => {
      if (!child.isText) {
        flushCarry();
        out.push({ kind: "inline", key: `I${JSON.stringify(child.toJSON())}`, node: child });
        return;
      }
      const marks = child.marks;
      const mk = marksKey(marks);
      for (const { segment, isWordLike } of segmenter.segment(child.text ?? "")) {
        if (SPACE.test(segment)) {
          if (carry && !sameMarks(carryMarks, marks)) flushCarry();
          if (!carry) carryMarks = marks;
          carry += segment;
          continue;
        }
        out.push({
          kind: "text",
          key: `T${mk}\u0001${segment}`,
          ws: carry,
          core: segment,
          word: isWordLike === true,
          marks,
          ...(carry && !sameMarks(carryMarks, marks) ? { wsMarks: carryMarks } : {}),
        });
        carry = "";
      }
    });
    flushCarry();
  } else out.push({ kind: "atom", key: `A${blockKey(node)}`, node });
  tokCache.set(node, out);
  return out;
}

/** A document side: its blocks and flattened tokens, with the maps between them. */
export interface Side {
  blocks: readonly PMNode[];
  toks: Tok[];
  starts: number[]; // token index of each block start; starts[blocks.length] = toks.length
  blockOf: Int32Array; // token index -> block index
}

const sideCache = new WeakMap<readonly PMNode[], Side>();
/** Cached by the blocks array: a caller that keeps its base array between recomputes flattens it once. */
export function buildSide(blocks: readonly PMNode[]): Side {
  let side = sideCache.get(blocks);
  if (!side) {
    side = flatten(blocks);
    sideCache.set(blocks, side);
  }
  return side;
}

function flatten(blocks: readonly PMNode[]): Side {
  const toks: Tok[] = [];
  const starts: number[] = [];
  for (const b of blocks) {
    starts.push(toks.length);
    for (const t of tokenizeBlock(b)) toks.push(t);
  }
  starts.push(toks.length);
  const blockOf = new Int32Array(toks.length);
  for (let i = 0; i < blocks.length; i++) blockOf.fill(i, starts[i], starts[i + 1]);
  return { blocks, toks, starts, blockOf };
}

/** Rebuilds blocks from tokens. Never drops content: inline nodes a block can't hold follow it in a paragraph. */
export function buildBlocks(
  schema: Schema,
  toks: readonly Tok[],
  opts: { allowEmpty?: boolean } = {},
): { blocks: PMNode[]; normalized: number } {
  const blocks: PMNode[] = [];
  let normalized = 0;
  let cur: { shell: PMNode; inline: PMNode[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const { shell, inline } = cur;
    cur = null;
    const type = shell.type;
    const fixed = inline.map((n) => (n.isText ? n.mark(type.allowedMarks(n.marks)) : n));
    if (fixed.some((n, i) => n !== inline[i])) normalized++;
    const allowed = fixed.filter((n) => type.contentMatch.matchType(n.type));
    const rejected = fixed.filter((n) => !type.contentMatch.matchType(n.type));
    blocks.push(type.create(shell.attrs, joinText(allowed), shell.marks));
    if (rejected.length) {
      normalized++;
      blocks.push(schema.nodes.paragraph.create(null, joinText(rejected)));
    }
  };
  for (const t of toks) {
    if (t.kind === "block") {
      flush();
      cur = { shell: t.node, inline: [] };
    } else if (t.kind === "atom") {
      flush();
      blocks.push(t.node);
    } else {
      if (!cur) {
        // Inline content with no textblock to hold it (after a whole block, or at the start).
        cur = { shell: schema.nodes.paragraph.create(), inline: [] };
        normalized++;
      }
      if (t.kind === "text") {
        if (t.wsMarks && t.ws)
          cur.inline.push(schema.text(t.ws, t.wsMarks), schema.text(t.core, t.marks));
        else cur.inline.push(schema.text(t.ws + t.core, t.marks));
      } else cur.inline.push(t.node);
    }
  }
  flush();
  if (!blocks.length && !opts.allowEmpty) blocks.push(schema.nodes.paragraph.create());
  return { blocks, normalized };
}

function joinText(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const n of nodes) {
    const prev = out.at(-1);
    if (prev?.isText && n.isText && prev.sameMarkup(n))
      out[out.length - 1] = prev.type.schema.text(`${prev.text}${n.text}`, prev.marks);
    else out.push(n);
  }
  return out;
}

// ---------- shared diff helpers ----------
// Text alone decides the diff: no deadline may cut it short, so its cost is bounded by input size alone.
// The library reads `timeout || 1` (0 becomes a one-second deadline) and treats a negative timeout as
// "never", so -1 is the only value that turns the deadline off.
const NO_DEADLINE = { checkLines: false, timeout: -1 };
// Past these sizes (both sides together, after trimming what they share at the ends) a diff is one delete
// and one insert: coarser, never wrong. Similar inputs this large diff in milliseconds; the bound exists for
// dissimilar ones (a full rewrite), whose worst case grows quadratically: about 60 ms at 4,000 keys and
// 170 ms at 20,000 characters, where 16,000 keys took 0.6 s and a 50k-word rewrite stalled Discard past 30 s.
const MAX_DIFF_KEYS = 4_000;
const MAX_DIFF_CHARS = 20_000;

const coarse = <T>(a: T, b: T, empty: (x: T) => boolean): Array<[number, T]> => [
  ...(empty(a) ? [] : [[DIFF_DELETE, a] as [number, T]]),
  ...(empty(b) ? [] : [[DIFF_INSERT, b] as [number, T]]),
];

/** The one diff-match-patch call: a character diff of two strings, with no wall-clock deadline. */
export function textDiff(a: string, b: string): Array<[number, string]> {
  if (a.length + b.length > MAX_DIFF_CHARS) return coarse(a, b, (x) => !x);
  return makeDiff(a, b, NO_DEADLINE) as Array<[number, string]>;
}

/** Largest count of distinct keys one UTF-16 code per key can name (the surrogate block is skipped). */
const MAX_CODES = 0xffff - 0x800 - 1;

/** One code per distinct key, so dmp can diff key sequences as strings. Null once the codes run out. */
function encodeKeys(keys: readonly string[], codes: Map<string, string>): string | null {
  let s = "";
  for (const k of keys) {
    let c = codes.get(k);
    if (c === undefined) {
      if (codes.size >= MAX_CODES) return null;
      const index = codes.size + 1;
      c = String.fromCharCode(index < 0xd800 ? index : index + 0x800);
      codes.set(k, c);
    }
    s += c;
  }
  return s;
}

/**
 * Diffs two key sequences as `[op, count]` runs, the one entry point every diff caller uses. The common
 * prefix and suffix are trimmed first; if the middle is still past `MAX_DIFF_KEYS`, or has more distinct
 * keys than a code can name, it is one delete and one insert (coarser, never wrong).
 */
export function diffKeys(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo] === b[lo]) lo++;
  let hi = 0;
  while (hi < a.length - lo && hi < b.length - lo && a[a.length - 1 - hi] === b[b.length - 1 - hi])
    hi++;
  const ma = a.slice(lo, a.length - hi);
  const mb = b.slice(lo, b.length - hi);
  const out: Array<[number, number]> = [];
  const push = (op: number, n: number) => {
    if (n > 0) out.push([op, n]);
  };
  push(DIFF_EQUAL, lo);
  const codes = new Map<string, string>();
  const ea = ma.length + mb.length > MAX_DIFF_KEYS ? null : encodeKeys(ma, codes);
  const eb = ea === null ? null : encodeKeys(mb, codes);
  if (ea === null || eb === null) {
    push(DIFF_DELETE, ma.length);
    push(DIFF_INSERT, mb.length);
  } else for (const [op, text] of textDiff(ea, eb)) push(op, text.length);
  push(DIFF_EQUAL, hi);
  return out;
}

/** A string as the word, space and punctuation segments the review tokenizer uses; they concatenate back to it. */
export const splitWords = (text: string): string[] =>
  Array.from(segmenter.segment(text), (s) => s.segment);

const wordKeys = new WeakMap<PMNode, string[]>();
/** A block's words in order (a non-text block is one pseudo-word: its key). */
export function blockWords(node: PMNode): string[] {
  let w = wordKeys.get(node);
  if (!w) {
    w = node.isTextblock
      ? tokenizeBlock(node).flatMap((t) => (t.kind === "text" && t.word ? [t.core] : []))
      : [blockKey(node)];
    wordKeys.set(node, w);
  }
  return w;
}

const wordCounts = new WeakMap<PMNode, Map<string, number>>();
/** Shared words ignoring order: an upper bound on the in-order count, and cheap. */
function sharedBound(a: PMNode, b: PMNode): number {
  const get = (n: PMNode) => {
    let m = wordCounts.get(n);
    if (!m) {
      m = new Map();
      for (const w of blockWords(n)) m.set(w, (m.get(w) ?? 0) + 1);
      wordCounts.set(n, m);
    }
    return m;
  };
  const [x, y] = [get(a), get(b)];
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  let n = 0;
  for (const [w, c] of small) n += Math.min(c, big.get(w) ?? 0);
  return n;
}

/**
 * Share of words two blocks have in order, over the longer block's words (or the shorter's, for
 * `inPlace` pairs, where position already agrees). 1 for equal blocks, 0 for different kinds of block
 * or when it can't reach `floor`.
 */
export function similarity(a: PMNode, b: PMNode, inPlace = false, floor = 0): number {
  if (a.type !== b.type && !(a.isTextblock && b.isTextblock)) return 0;
  if (blockKey(a) === blockKey(b)) return 1;
  const x = blockWords(a);
  const y = blockWords(b);
  if (!x.length || !y.length || !a.isTextblock || !b.isTextblock) return 0;
  const denom = inPlace ? Math.min(x.length, y.length) : Math.max(x.length, y.length);
  const bound = sharedBound(a, b);
  // Disjoint word sets cannot have an in-order match, even when no floor was requested.
  if (bound === 0 || (floor > 0 && bound / denom < floor)) return 0;
  let common = 0;
  for (const [op, n] of diffKeys(x, y)) if (op === DIFF_EQUAL) common += n;
  return common / denom;
}

/**
 * Diff at word granularity over the review's own segments, as `[op, text]` runs. A character diff reuses
 * letters across words, so a peer deleting the old word deletes part of the new one: garbled text. The
 * AI write lowering and the Yjs writer both read it, so one edit has one set of unchanged words.
 */
export function wordDiff(a: string, b: string): Array<[number, string]> {
  const wa = splitWords(a);
  const wb = splitWords(b);
  let i = 0;
  let j = 0;
  return diffKeys(wa, wb).map(([op, n]) => {
    const from = op === DIFF_INSERT ? wb : wa;
    const at = op === DIFF_INSERT ? j : i;
    if (op !== DIFF_INSERT) i += n;
    if (op !== DIFF_DELETE) j += n;
    return [op, from.slice(at, at + n).join("")];
  });
}
