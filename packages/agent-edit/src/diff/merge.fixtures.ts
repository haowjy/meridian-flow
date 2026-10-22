/**
 * Fixtures for the merge's tests: a tiny document notation, seeded random documents with concurrent edit
 * scripts and ground truth, an invariant oracle that follows each unique word through a merge, and the
 * spec's fixed case table (spec-content-rebase.md section 5). Words are unique ("w17") so a word's text
 * is its identity.
 */
import type { Node as PMNode, Schema } from "prosemirror-model";
import type { Conflict } from "./merge.js";
import type { Tok } from "./tokens.js";

export function parseDoc(schema: Schema, src: string): PMNode[] {
  return src.split(" | ").map((part) => {
    const i = part.indexOf(":");
    const kind = i < 0 ? part.trim() : part.slice(0, i).trim();
    const text = i < 0 ? "" : part.slice(i + 1);
    if (kind === "hr") return schema.nodes.horizontal_rule.create();
    if (kind === "fig") return schema.nodes.figure.create({ src: `asset:${text}`, alt: text });
    if (kind === "quote")
      return schema.nodes.blockquote.create(
        null,
        schema.nodes.paragraph.create(null, inline(schema, text)),
      );
    if (kind === "list")
      return schema.nodes.bullet_list.create(
        null,
        text
          .split(";")
          .map((t) =>
            schema.nodes.list_item.create(
              null,
              schema.nodes.paragraph.create(null, inline(schema, t)),
            ),
          ),
      );
    if (kind.startsWith("h"))
      return schema.nodes.heading.create(
        { level: Number(kind.slice(1)) || 1 },
        inline(schema, text),
      );
    if (kind === "p") return schema.nodes.paragraph.create(null, inline(schema, text));
    if (kind === "pc")
      return schema.nodes.paragraph.create({ align: "center" }, inline(schema, text));
    throw new Error(`bad block ${part}`);
  });
}

function inline(schema: Schema, text: string): PMNode[] {
  const out: PMNode[] = [];
  for (const m of text.matchAll(/\*\*([^*]+)\*\*|\*([^*]+)\*|\[([^\]]+)\]\(([^)]+)\)|([^*[]+)/g)) {
    if (m[1]) out.push(schema.text(m[1], [schema.marks.strong.create()]));
    else if (m[2]) out.push(schema.text(m[2], [schema.marks.em.create()]));
    else if (m[3]) out.push(schema.text(m[3], [schema.marks.link.create({ href: m[4] })]));
    else if (m[5]) out.push(schema.text(m[5]));
  }
  return out;
}

export function render(blocks: readonly PMNode[]): string {
  return blocks
    .map((b) => {
      if (b.type.name === "horizontal_rule") return "hr";
      if (b.type.name === "figure") return `fig:${b.attrs.alt}`;
      if (b.type.name === "blockquote") return `quote:${b.textContent}`;
      if (b.type.name === "bullet_list") {
        const items: string[] = [];
        b.forEach((li) => {
          items.push(li.textContent);
        });
        return `list:${items.join(";")}`;
      }
      let t = "";
      b.forEach((n) => {
        const em = n.marks.some((m) => m.type.name === "em");
        const st = n.marks.some((m) => m.type.name === "strong");
        const link = n.marks.find((m) => m.type.name === "link");
        let s = n.text ?? "";
        if (link) s = `[${s}](${link.attrs.href})`;
        t += st && em ? `***${s}***` : st ? `**${s}**` : em ? `*${s}*` : s;
      });
      const kind =
        b.type.name === "heading" ? `h${b.attrs.level}` : b.attrs.align === "center" ? "pc" : "p";
      return `${kind}:${t}`;
    })
    .join(" | ");
}

export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    // mulberry32
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

export type Word = { t: string; em: boolean; strong: boolean; dot: boolean };
export type GBlock =
  | { kind: "text"; type: "paragraph" | "heading"; level: number; words: Word[]; origins: number[] }
  | { kind: "figure"; alt: string; origins: number[] }
  | { kind: "rule"; origins: number[] };

export type OpName =
  | "replaceWord"
  | "insertWords"
  | "deleteWords"
  | "toggleMark"
  | "split"
  | "merge"
  | "insertBlock"
  | "deleteBlock"
  | "moveBlock"
  | "setType"
  | "insertFigure"
  | "insertRule"
  | "repeatBlock";

export interface Script {
  ops: OpName[];
  touched: Set<number>; // base block ids this side's own ops touched
  moved: Set<number>; // base block ids this side moved
  edited: Set<number>; // base block ids this side touched other than by moving
  structural: boolean; // split, merged or deleted a block
  restructured: Set<number>; // base block ids this side split, merged or deleted
}

export interface Scenario {
  base: GBlock[];
  live: GBlock[];
  draft: GBlock[];
  shared: Script;
  liveScript: Script;
  draftScript: Script;
  repeats: boolean; // some text is deliberately not unique
  copied: Set<string>; // words a repeatBlock op copied: their text no longer names one word
}

export interface GenOptions {
  blocks?: number;
  maxOps?: number;
  sharedP?: number;
  moveP?: number;
  repeats?: boolean;
  ops?: OpName[]; // restrict op mix
}

let counter = 0;
const copiedWords = new Set<string>();
const fresh = (): Word => ({ t: `w${++counter}`, em: false, strong: false, dot: false });

export function resetWords(start = 0) {
  counter = start;
  copiedWords.clear();
}

function textBlock(rng: Rng, n: number, origins: number[]): GBlock {
  const words = Array.from({ length: n }, () => {
    const w = fresh();
    w.em = rng.chance(0.1);
    w.dot = rng.chance(0.2);
    return w;
  });
  const heading = rng.chance(0.15);
  return {
    kind: "text",
    type: heading ? "heading" : "paragraph",
    level: heading ? 1 + rng.int(3) : 1,
    words,
    origins,
  };
}

export function genBase(rng: Rng, nBlocks: number): GBlock[] {
  const out: GBlock[] = [];
  for (let i = 0; i < nBlocks; i++) {
    const r = rng.next();
    if (r < 0.06) out.push({ kind: "figure", alt: `fig${++counter}`, origins: [i] });
    else if (r < 0.1) out.push({ kind: "rule", origins: [i] });
    else out.push(textBlock(rng, 2 + rng.int(7), [i]));
  }
  return out;
}

const clone = (bs: GBlock[]): GBlock[] =>
  bs.map((b) =>
    b.kind === "text"
      ? { ...b, words: b.words.map((w) => ({ ...w })), origins: [...b.origins] }
      : { ...b, origins: [...b.origins] },
  );

const ALL_OPS: OpName[] = [
  "replaceWord",
  "insertWords",
  "deleteWords",
  "toggleMark",
  "split",
  "merge",
  "insertBlock",
  "deleteBlock",
  "moveBlock",
  "setType",
  "insertFigure",
  "insertRule",
];

/** Applies one random op in place; returns the op name or null if it didn't apply. */
function applyOp(rng: Rng, doc: GBlock[], sc: Script, opts: GenOptions): OpName | null {
  const touched = new Set<number>();
  const op = applyOpInner(rng, doc, touched, opts);
  for (const id of touched) {
    sc.touched.add(id);
    (op === "moveBlock" ? sc.moved : sc.edited).add(id);
  }
  if (op === "split" || op === "merge" || op === "deleteBlock") {
    sc.structural = true;
    for (const id of touched) sc.restructured.add(id);
  }
  return op;
}

function applyOpInner(
  rng: Rng,
  doc: GBlock[],
  touched: Set<number>,
  opts: GenOptions,
): OpName | null {
  const mix = opts.ops ?? [
    ...ALL_OPS,
    ...(opts.repeats ? (["repeatBlock", "repeatBlock"] as OpName[]) : []),
  ];
  const weights: Partial<Record<OpName, number>> = {
    replaceWord: 3,
    insertWords: 3,
    deleteWords: 2,
    toggleMark: 1.5,
    split: 1.2,
    merge: 1.2,
    insertBlock: 1.5,
    deleteBlock: 1,
    moveBlock: (opts.moveP ?? 0.15) * 10,
    setType: 0.8,
    insertFigure: 0.3,
    insertRule: 0.3,
    repeatBlock: 1,
  };
  const total = mix.reduce((s, o) => s + (weights[o] ?? 1), 0);
  let r = rng.next() * total;
  let op = mix[0];
  for (const o of mix) {
    r -= weights[o] ?? 1;
    if (r <= 0) {
      op = o;
      break;
    }
  }
  const touch = (b: GBlock) => {
    for (const o of b.origins) touched.add(o);
  };
  const texts = doc.map((b, i) => [b, i] as const).filter(([b]) => b.kind === "text") as Array<
    readonly [Extract<GBlock, { kind: "text" }>, number]
  >;
  const withWords = texts.filter(([b]) => b.words.length > 0);
  switch (op) {
    case "replaceWord": {
      if (!withWords.length) return null;
      const [b] = rng.pick(withWords);
      const i = rng.int(b.words.length);
      const w = fresh();
      w.dot = b.words[i].dot;
      b.words[i] = w;
      touch(b);
      return op;
    }
    case "insertWords": {
      if (!texts.length) return null;
      const [b] = rng.pick(texts);
      const at = rng.int(b.words.length + 1);
      b.words.splice(at, 0, ...Array.from({ length: 1 + rng.int(3) }, fresh));
      touch(b);
      return op;
    }
    case "deleteWords": {
      if (!withWords.length) return null;
      const [b] = rng.pick(withWords);
      const at = rng.int(b.words.length);
      b.words.splice(at, 1 + rng.int(Math.min(2, b.words.length - at)));
      touch(b);
      return op;
    }
    case "toggleMark": {
      if (!withWords.length) return null;
      const [b] = rng.pick(withWords);
      const at = rng.int(b.words.length);
      const len = 1 + rng.int(Math.min(3, b.words.length - at));
      const strong = rng.chance(0.3);
      for (let k = at; k < at + len; k++) {
        if (strong) b.words[k].strong = !b.words[k].strong;
        else b.words[k].em = !b.words[k].em;
      }
      touch(b);
      return op;
    }
    case "split": {
      const cands = texts.filter(([b]) => b.words.length >= 2);
      if (!cands.length) return null;
      const [b, i] = rng.pick(cands);
      const k = 1 + rng.int(b.words.length - 1);
      const tail = b.words.splice(k);
      doc.splice(i + 1, 0, {
        kind: "text",
        type: "paragraph",
        level: 1,
        words: tail,
        origins: [...b.origins],
      });
      touch(b);
      return op;
    }
    case "merge": {
      const cands = texts.filter(([, i]) => i + 1 < doc.length && doc[i + 1].kind === "text");
      if (!cands.length) return null;
      const [b, i] = rng.pick(cands);
      const next = doc[i + 1] as Extract<GBlock, { kind: "text" }>;
      touch(b);
      touch(next);
      b.words.push(...next.words);
      b.origins = [...new Set([...b.origins, ...next.origins])];
      doc.splice(i + 1, 1);
      return op;
    }
    case "insertBlock": {
      doc.splice(rng.int(doc.length + 1), 0, textBlock(rng, 2 + rng.int(4), []));
      return op;
    }
    case "repeatBlock": {
      // Deliberate repeated content: a copy of an existing paragraph (same words) somewhere else.
      if (!withWords.length) return null;
      const [b] = rng.pick(withWords);
      for (const w of b.words) copiedWords.add(w.t);
      doc.splice(rng.int(doc.length + 1), 0, {
        ...b,
        words: b.words.map((w) => ({ ...w })),
        origins: [],
      });
      return op;
    }
    case "deleteBlock": {
      if (doc.length <= 1) return null;
      const i = rng.int(doc.length);
      touch(doc[i]);
      doc.splice(i, 1);
      return op;
    }
    case "moveBlock": {
      if (doc.length < 2) return null;
      const i = rng.int(doc.length);
      const [b] = doc.splice(i, 1);
      let j = rng.int(doc.length + 1);
      if (j === i) j = (j + 1) % (doc.length + 1);
      doc.splice(j, 0, b);
      touch(b);
      return op;
    }
    case "setType": {
      if (!texts.length) return null;
      const [b] = rng.pick(texts);
      if (b.type === "heading") b.type = "paragraph";
      else {
        b.type = "heading";
        b.level = 1 + rng.int(3);
      }
      touch(b);
      return op;
    }
    case "insertFigure": {
      doc.splice(rng.int(doc.length + 1), 0, {
        kind: "figure",
        alt: `fig${++counter}`,
        origins: [],
      });
      return op;
    }
    case "insertRule": {
      doc.splice(rng.int(doc.length + 1), 0, { kind: "rule", origins: [] });
      return op;
    }
  }
  return null;
}

export function runScript(rng: Rng, doc: GBlock[], n: number, opts: GenOptions): Script {
  const s: Script = {
    ops: [],
    touched: new Set(),
    moved: new Set(),
    edited: new Set(),
    structural: false,
    restructured: new Set(),
  };
  for (let k = 0; k < n; k++) {
    const op = applyOp(rng, doc, s, opts);
    if (op) s.ops.push(op);
  }
  return s;
}

/** Scenario features the spec treats as known limitations, so failures are bucketed apart. */
export function limitations(sc: Scenario): string[] {
  const out: string[] = [];
  if (sc.shared.ops.length) out.push("same-edit-both-sides");
  const [l, d] = [sc.liveScript, sc.draftScript];
  const selfRestructured = [l, d].some((x) => [...x.moved].some((id) => x.restructured.has(id)));
  if ((l.moved.size && d.structural) || (d.moved.size && l.structural) || selfRestructured)
    out.push("move-vs-restructure");
  return out;
}

export function genScenario(rng: Rng, opts: GenOptions = {}): Scenario {
  const base = genBase(rng, opts.blocks ?? 3 + rng.int(10));
  const mid = clone(base);
  const shared = runScript(rng, mid, rng.chance(opts.sharedP ?? 0.25) ? 1 + rng.int(2) : 0, opts);
  const live = clone(mid);
  const draft = clone(mid);
  const maxOps = opts.maxOps ?? 4;
  const liveScript = runScript(rng, live, rng.int(maxOps + 1), opts);
  const draftScript = runScript(rng, draft, rng.int(maxOps + 1), opts);
  return {
    base,
    live,
    draft,
    shared,
    liveScript,
    draftScript,
    repeats: !!opts.repeats,
    copied: new Set(copiedWords),
  };
}

export function toPM(schema: Schema, doc: GBlock[]): PMNode[] {
  return doc.map((b) => {
    if (b.kind === "figure")
      return schema.nodes.figure.create({ src: `asset:${b.alt}`, alt: b.alt });
    if (b.kind === "rule") return schema.nodes.horizontal_rule.create();
    const inline: PMNode[] = [];
    b.words.forEach((w, i) => {
      if (i > 0) inline.push(schema.text(" "));
      const marks = [
        ...(w.em ? [schema.marks.em.create()] : []),
        ...(w.strong ? [schema.marks.strong.create()] : []),
      ];
      inline.push(schema.text(w.t, marks));
      if (w.dot) inline.push(schema.text("."));
    });
    const content = joinAdjacent(inline);
    return b.type === "heading"
      ? schema.nodes.heading.create({ level: b.level }, content)
      : schema.nodes.paragraph.create(null, content);
  });
}

function joinAdjacent(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const n of nodes) {
    const prev = out.at(-1);
    if (prev?.sameMarkup(n))
      out[out.length - 1] = prev.type.schema.text(`${prev.text}${n.text}`, prev.marks);
    else out.push(n);
  }
  return out;
}

// Han characters are words of their own (the tokens segment them), as in production.
const WORD = /\p{sc=Han}|[\p{L}\p{N}_]+/gu;

export interface WordInfo {
  pos: number;
  block: number;
  em: boolean;
  strong: boolean;
  type: string;
  first: boolean;
}

export function wordsOf(blocks: readonly PMNode[]): {
  list: string[];
  info: Map<string, WordInfo>;
  count: Map<string, number>;
} {
  const list: string[] = [];
  const info = new Map<string, WordInfo>();
  const count = new Map<string, number>();
  blocks.forEach((b, bi) => {
    const type = b.type.name === "heading" ? `heading${b.attrs.level}` : b.type.name;
    let first = true;
    const add = (w: string, em: boolean, strong: boolean) => {
      count.set(w, (count.get(w) ?? 0) + 1);
      info.set(w, { pos: list.length, block: bi, em, strong, type, first });
      list.push(w);
      first = false;
    };
    if (b.type.name === "figure") add(`fig:${b.attrs.alt}`, false, false);
    b.forEach((n) => {
      if (!n.isText) return;
      const em = n.marks.some((m) => m.type.name === "em");
      const strong = n.marks.some((m) => m.type.name === "strong");
      for (const m of (n.text ?? "").matchAll(WORD)) add(m[0], em, strong);
    });
  });
  return { list, info, count };
}

export function tokWords(toks: readonly Tok[]): string[] {
  const out: string[] = [];
  for (const t of toks) {
    if (t.kind === "text") for (const m of t.core.matchAll(WORD)) out.push(m[0]);
    else if (t.kind === "atom" && t.node.type.name === "figure")
      out.push(`fig:${t.node.attrs.alt}`);
  }
  return out;
}

export interface OracleInput {
  base: readonly PMNode[];
  live: readonly PMNode[];
  draft: readonly PMNode[];
  merged: readonly PMNode[];
  conflicts: readonly Conflict[];
  liveTouched?: Set<number>; // ground truth; omit to skip the legitimacy check
  draftTouched?: Set<number>;
  pairSamples?: number;
  orderConflict?: boolean; // the sides' moves admit no single order; the draft's order is used
  ambiguous?: Set<string>; // words known to have been copied, so their text doesn't name one word
}

export function check(o: OracleInput, rnd: () => number = Math.random): string[] {
  const B = wordsOf(o.base);
  const L = wordsOf(o.live);
  const D = wordsOf(o.draft);
  const M = wordsOf(o.merged);
  const fails: string[] = [];
  const fail = (s: string) => {
    if (fails.length < 12) fails.push(s);
  };
  const conflictWords = new Set<string>();
  const conflictBlocks = new Set<number>();
  for (const c of o.conflicts) {
    for (const w of [...tokWords(c.base), ...tokWords(c.live), ...tokWords(c.draft)])
      conflictWords.add(w);
    for (const id of c.baseIds) conflictBlocks.add(id);
  }
  // A word repeated in any version has no single identity; only count checks apply to it.
  const repeated = new Set<string>();
  for (const v of [B, L, D]) for (const [w, n] of v.count) if (n > 1) repeated.add(w);
  for (const w of o.ambiguous ?? []) repeated.add(w);
  const inConflictBlock = (w: string) => {
    const b = B.info.get(w);
    return b !== undefined && conflictBlocks.has(b.block);
  };
  const excused = (w: string) => conflictWords.has(w) || inConflictBlock(w);

  for (const [w, n] of M.count) {
    if (!B.count.has(w) && !L.count.has(w) && !D.count.has(w)) fail(`invented ${w}`);
    if (!repeated.has(w) && n > 1 && !excused(w)) fail(`duplicated ${w} x${n}`);
    if (repeated.has(w)) {
      const cb = B.count.get(w) ?? 0;
      const cl = L.count.get(w) ?? 0;
      const cd = D.count.get(w) ?? 0;
      if (n > cb + Math.max(0, cl - cb) + Math.max(0, cd - cb) && !excused(w))
        fail(`repeated ${w}: ${n} copies from b${cb} l${cl} d${cd}`);
    }
  }
  for (const [w, cd] of D.count) {
    const cb = B.count.get(w) ?? 0;
    const cl = L.count.get(w) ?? 0;
    const cm = M.count.get(w) ?? 0;
    if (repeated.has(w)) {
      if (cd > cb && cm < cd - Math.max(0, cb - cl))
        fail(`draft copy of repeated ${w} lost: m${cm} d${cd} b${cb} l${cl}`);
      continue;
    }
    if (!cb && !cm) fail(`draft insertion lost: ${w}`);
    // A word live moved into a conflict region shows red there (live has it, the draft doesn't).
    if (cb && cl && !cm && !conflictWords.has(w)) fail(`kept-by-both word lost: ${w}`);
    if (cb && !cl && cm && !inConflictBlock(w)) fail(`resurrected live deletion: ${w}`);
  }
  for (const [w] of B.count) {
    if (repeated.has(w)) continue;
    if (!D.count.has(w) && M.count.has(w) && !inConflictBlock(w))
      fail(`draft deletion undone: ${w}`);
  }
  for (const [w] of L.count) {
    if (repeated.has(w) || B.count.has(w)) continue;
    if (!M.count.has(w) && !conflictWords.has(w)) fail(`live insertion dropped: ${w}`);
  }
  const { liveTouched, draftTouched } = o;
  if (liveTouched && draftTouched) {
    for (const c of o.conflicts) {
      if (!c.baseIds.some((id) => liveTouched.has(id) && draftTouched.has(id)))
        fail(
          `conflict on blocks [${c.baseIds}] neither both sides touched: live ${tokWords(c.live).join(" ")} / draft ${tokWords(c.draft).join(" ")}`,
        );
    }
  }

  // Attributes, order and block structure, for identifiable words outside conflicts.
  const ok = (w: string) => !repeated.has(w) && !excused(w) && (M.count.get(w) ?? 0) === 1;
  const rule = <T>(b: T, l: T, d: T) => (l === b ? d : d === b ? l : d);
  for (const w of M.list) {
    if (!ok(w)) continue;
    const m = M.info.get(w);
    if (!m) throw new Error(`merged word ${w} has no info`);
    const b = B.info.get(w);
    const l = L.info.get(w);
    const d = D.info.get(w);
    for (const attr of ["em", "strong"] as const) {
      let exp: boolean | undefined;
      if (b && l && d) exp = rule(b[attr], l[attr], d[attr]);
      else if (l && !d) exp = l[attr];
      else if (d && !l) exp = d[attr];
      else if (l && d && l[attr] === d[attr]) exp = l[attr];
      if (exp !== undefined && m[attr] !== exp)
        fail(`${attr} on ${w}: got ${m[attr]}, want ${exp}`);
    }
    if (b && l && d && b.first && l.first && d.first && m.first) {
      const exp = rule(b.type, l.type, d.type);
      if (m.type !== exp) fail(`block type at ${w}: got ${m.type}, want ${exp}`);
    }
  }
  const pairExp = (
    u: string,
    v: string,
    f: (x: WordInfo, y: WordInfo) => boolean,
  ): boolean | undefined => {
    const [bu, bv, lu, lv, du, dv] = [
      B.info.get(u),
      B.info.get(v),
      L.info.get(u),
      L.info.get(v),
      D.info.get(u),
      D.info.get(v),
    ];
    const inB = bu && bv;
    const inL = lu && lv;
    const inD = du && dv;
    if (inB && inL && inD) return rule(f(bu, bv), f(lu, lv), f(du, dv));
    // One-sided words: only within one block of that side, where the side's order is unambiguous.
    if (inL && !inD && lu.block === lv.block) return f(lu, lv);
    if (inD && !inL && du.block === dv.block) return f(du, dv);
    if (inL && inD && !inB && f(lu, lv) === f(du, dv)) return f(lu, lv);
    return undefined;
  };
  const ids = M.list.filter(ok);
  const samples = o.pairSamples ?? 200;
  const pairs: Array<[string, string]> = [];
  if (ids.length * ids.length <= samples * 2) {
    for (let i = 0; i < ids.length; i++)
      for (let j = i + 1; j < ids.length; j++) pairs.push([ids[i], ids[j]]);
  } else {
    for (let k = 0; k < samples; k++) {
      const i = Math.floor(rnd() * ids.length);
      const j = Math.floor(rnd() * ids.length);
      if (i !== j) pairs.push([ids[Math.min(i, j)], ids[Math.max(i, j)]]);
    }
  }
  for (const [u, v] of o.orderConflict ? [] : pairs) {
    const exp = pairExp(u, v, (x, y) => x.pos < y.pos);
    if (exp === false) fail(`order: ${u} before ${v}, want after`);
  }
  for (let i = 0; i + 1 < M.list.length; i++) {
    const [u, v] = [M.list[i], M.list[i + 1]];
    if (!ok(u) || !ok(v)) continue;
    // Only base words: where a one-sided word lands relative to the other side's new paragraph
    // break at the same point is a presentation choice (words first), not an invariant.
    if (!B.info.has(u) || !B.info.has(v)) continue;
    const exp = pairExp(u, v, (x, y) => x.block === y.block);
    const [mu, mv] = [M.info.get(u), M.info.get(v)];
    if (!mu || !mv) throw new Error(`merged words ${u}, ${v} have no info`);
    const got = mu.block === mv.block;
    if (exp !== undefined && exp !== got) fail(`blocks: ${u}|${v} same=${got}, want ${exp}`);
  }
  return fails;
}

export const show = (bs: readonly PMNode[]) =>
  bs
    .map(
      (b) =>
        `${b.type.name === "heading" ? `h${b.attrs.level}` : b.type.name === "paragraph" ? "p" : b.type.name}[${b.type.name === "figure" ? b.attrs.alt : b.textContent}]`,
    )
    .join(" ");

export interface Case {
  row: string; // case-table row
  name: string;
  base: string;
  live: string;
  draft: string;
  merged: string;
  conflicts: number;
}

const P3 =
  "p:Lin Feng drew his sword and stepped forward. | p:The elder watched him with cold eyes. | p:Thunder rolled across the peak.";
const LIN = "p:Lin Feng drew his sword and stepped forward.";
const ELDER = "p:The elder watched him with cold eyes.";
const THUNDER = "p:Thunder rolled across the peak.";
const SIX = ["aa", "bb", "cc", "dd", "ee", "ff"].map((w) => `p:${w} ${w} ${w}`);

export const CASES: Case[] = [
  // Text in one paragraph
  {
    row: "same word, different edits",
    name: "word-conflict",
    base: "p:The cat sat on the mat.",
    live: "p:The dog sat on the mat.",
    draft: "p:The bird sat on the mat.",
    merged: "p:The bird sat on the mat.",
    conflicts: 1,
  },
  {
    row: "same word, same edit",
    name: "word-same",
    base: "p:The cat sat.",
    live: "p:The dog sat.",
    draft: "p:The dog sat.",
    merged: "p:The dog sat.",
    conflicts: 0,
  },
  {
    row: "same paragraph, different words",
    name: "para-different-words",
    base: "p:The cat sat on the mat.",
    live: "p:The dog sat on the mat.",
    draft: "p:The cat sat on the rug.",
    merged: "p:The dog sat on the rug.",
    conflicts: 0,
  },
  {
    row: "same-point insertions, equal",
    name: "insert-equal",
    base: "p:She ran.",
    live: "p:She ran home.",
    draft: "p:She ran home.",
    merged: "p:She ran home.",
    conflicts: 0,
  },
  {
    row: "same-point insertions, different",
    name: "insert-different",
    base: "p:She ran.",
    live: "p:She ran home.",
    draft: "p:She ran fast.",
    merged: "p:She ran home fast.",
    conflicts: 0,
  },
  {
    row: "same-point insertions, different",
    name: "insert-paragraphs-different",
    base: "p:One. | p:Two.",
    live: "p:One. | p:Rain fell. | p:Two.",
    draft: "p:One. | p:Wind rose. | p:Two.",
    merged: "p:One. | p:Rain fell. | p:Wind rose. | p:Two.",
    conflicts: 0,
  },
  {
    row: "same-point insertions, equal",
    name: "insert-paragraphs-equal",
    base: "p:One. | p:Two.",
    live: "p:One. | p:New para. | p:Two.",
    draft: "p:One. | p:New para. | p:Two.",
    merged: "p:One. | p:New para. | p:Two.",
    conflicts: 0,
  },
  {
    row: "same insertion, then changed differently",
    name: "insert-diverged",
    base: "p:One. | p:Two.",
    live: "p:One. | p:The sect elders gathered at dawn. | p:Two.",
    draft: "p:One. | p:The sect elders gathered at noon. | p:Two.",
    merged: "p:One. | p:The sect elders gathered at noon. | p:Two.",
    conflicts: 1,
  },
  {
    row: "edit vs delete, same words",
    name: "replace-vs-delete",
    base: "p:a b c d",
    live: "p:a X d",
    draft: "p:a d",
    merged: "p:a d",
    conflicts: 1,
  },
  // Repeated content
  {
    row: "repeated content",
    name: "repeated-paragraphs",
    base: "p:He nodded. | p:She left the room. | p:He nodded.",
    live: "p:He nodded. | p:She left the room. | p:He nodded slowly.",
    draft: "p:He frowned. | p:She left the room. | p:He nodded.",
    merged: "p:He frowned. | p:She left the room. | p:He nodded slowly.",
    conflicts: 0,
  },
  {
    row: "repeated content",
    name: "repeated-sentences",
    base: "p:He nodded. She left. He nodded.",
    live: "p:He nodded. She left. He nodded slowly.",
    draft: "p:He frowned. She left. He nodded.",
    merged: "p:He frowned. She left. He nodded slowly.",
    conflicts: 0,
  },
  // Structure
  {
    row: "split vs edit",
    name: "live-split-draft-edit",
    base: "p:one two three four",
    live: "p:one two | p:three four",
    draft: "p:one TWO three four",
    merged: "p:one TWO | p:three four",
    conflicts: 0,
  },
  {
    row: "merge vs edit",
    name: "live-join-draft-edit",
    base: "p:one two | p:three four",
    live: "p:one two three four",
    draft: "p:one two | p:three FOUR",
    merged: "p:one two three FOUR",
    conflicts: 0,
  },
  {
    row: "merge vs edit",
    name: "draft-join-live-edit",
    base: "p:one two | p:three four",
    live: "p:one two | p:three FOUR",
    draft: "p:one two three four",
    merged: "p:one two three FOUR",
    conflicts: 0,
  },
  {
    row: "split on both sides",
    name: "split-same",
    base: "p:one two three four",
    live: "p:one two | p:three four",
    draft: "p:one two | p:three four",
    merged: "p:one two | p:three four",
    conflicts: 0,
  },
  {
    row: "split on both sides",
    name: "split-different",
    base: "p:one two three four",
    live: "p:one two | p:three four",
    draft: "p:one | p:two three four",
    merged: "p:one | p:two | p:three four",
    conflicts: 0,
  },
  {
    row: "merge vs split",
    name: "join-vs-split",
    base: "p:one two | p:three four",
    live: "p:one two three four",
    draft: "p:one two | p:three | p:four",
    merged: "p:one two three | p:four",
    conflicts: 0,
  },
  {
    row: "delete paragraph vs join onto it",
    name: "delete-vs-join",
    base: "p:aa bb cc | p:dd ee ff | p:gg hh",
    live: "p:aa bb cc | p:gg hh",
    draft: "p:aa bb cc dd ee ff | p:gg hh",
    merged: "p:aa bb cc dd ee ff | p:gg hh",
    conflicts: 1,
  },
  // Moves
  {
    row: "live moves, draft edits",
    name: "live-move-draft-edit",
    base: P3,
    live: `${THUNDER} | ${LIN} | ${ELDER}`,
    draft: `${LIN} | ${ELDER} | p:Thunder rolled across the silent peak.`,
    merged: `p:Thunder rolled across the silent peak. | ${LIN} | ${ELDER}`,
    conflicts: 0,
  },
  {
    row: "draft moves, live edits",
    name: "draft-move-live-edit",
    base: P3,
    live: `${LIN} | ${ELDER} | p:Thunder rolled across the silent peak.`,
    draft: `${THUNDER} | ${LIN} | ${ELDER}`,
    merged: `p:Thunder rolled across the silent peak. | ${LIN} | ${ELDER}`,
    conflicts: 0,
  },
  {
    row: "adjacent swap on one side, move on the other",
    name: "swap-ambiguity",
    base: P3,
    live: `${THUNDER} | ${LIN} | ${ELDER}`,
    draft: `${LIN} | ${THUNDER} | ${ELDER}`,
    merged: `${THUNDER} | ${LIN} | ${ELDER}`,
    conflicts: 0,
  },
  {
    row: "both move one paragraph to different places",
    name: "move-move",
    base: SIX.join(" | "),
    live: [SIX[0], SIX[2], SIX[3], SIX[4], SIX[1], SIX[5]].join(" | "),
    draft: [SIX[0], SIX[2], SIX[3], SIX[1], SIX[4], SIX[5]].join(" | "),
    merged: [SIX[0], SIX[2], SIX[3], SIX[1], SIX[4], SIX[5]].join(" | "),
    conflicts: 1,
  },
  {
    row: "moved text (cut and paste)",
    name: "draft-moves-sentence-live-edits-it",
    base: "p:Lin Feng drew his sword. The wind howled. | p:Thunder rolled across the peak.",
    live: "p:Lin Feng drew his sword. The cold wind howled. | p:Thunder rolled across the peak.",
    draft: "p:Lin Feng drew his sword. | p:Thunder rolled across the peak. The wind howled.",
    merged: "p:Lin Feng drew his sword. | p:Thunder rolled across the peak. The wind howled.",
    conflicts: 2,
  },
  {
    row: "moved text (cut and paste)",
    name: "live-moves-sentence-draft-edits-it",
    base: "p:Lin Feng drew his sword. The wind howled. | p:Thunder rolled across the peak.",
    live: "p:Lin Feng drew his sword. | p:Thunder rolled across the peak. The wind howled.",
    draft: "p:Lin Feng drew his sword. The cold wind howled. | p:Thunder rolled across the peak.",
    merged: "p:Lin Feng drew his sword. The cold wind howled. | p:Thunder rolled across the peak.",
    conflicts: 2,
  },
  // Delete vs edit
  {
    row: "live deletes, draft edits",
    name: "live-delete-draft-edit",
    base: P3,
    live: `${LIN} | ${THUNDER}`,
    draft: `${LIN} | p:The elder watched him with icy eyes. | ${THUNDER}`,
    merged: `${LIN} | p:The elder watched him with icy eyes. | ${THUNDER}`,
    conflicts: 1,
  },
  {
    row: "draft deletes, live edits",
    name: "draft-delete-live-edit",
    base: P3,
    live: `${LIN} | p:The elder watched him with icy eyes. | ${THUNDER}`,
    draft: `${LIN} | ${THUNDER}`,
    merged: `${LIN} | ${THUNDER}`,
    conflicts: 1,
  },
  {
    row: "draft deletes, live appends",
    name: "draft-delete-live-append",
    base: "p:a b | p:c d | p:f g",
    live: "p:a b | p:c d e | p:f g",
    draft: "p:a b | p:f g",
    merged: "p:a b | p:f g",
    conflicts: 1,
  },
  {
    row: "draft deletes everything",
    name: "draft-empties",
    base: "p:a b | p:c d",
    live: "p:a b | p:c d e",
    draft: "p:",
    merged: "p:",
    conflicts: 1,
  },
  {
    row: "live deletes everything",
    name: "live-empties",
    base: "p:a b | p:c d",
    live: "p:",
    draft: "p:a b | p:c d e",
    merged: "p:a b | p:c d e",
    conflicts: 1,
  },
  {
    row: "both delete",
    name: "both-delete",
    base: P3,
    live: `${LIN} | ${THUNDER}`,
    draft: `${LIN} | ${THUNDER}`,
    merged: `${LIN} | ${THUNDER}`,
    conflicts: 0,
  },
  // Block type, marks, attrs
  {
    row: "block type vs text",
    name: "heading-vs-text",
    base: "p:Chapter One | p:Body text here.",
    live: "h2:Chapter One | p:Body text here.",
    draft: "p:Chapter One: Dawn | p:Body text here.",
    merged: "h2:Chapter One: Dawn | p:Body text here.",
    conflicts: 0,
  },
  {
    row: "block type vs block type",
    name: "heading-vs-heading",
    base: "p:Chapter One | p:Body text here.",
    live: "h2:Chapter One | p:Body text here.",
    draft: "h3:Chapter One | p:Body text here.",
    merged: "h3:Chapter One | p:Body text here.",
    conflicts: 1,
  },
  {
    row: "marks: different marks, same word",
    name: "bold-vs-italic",
    base: "p:He said no.",
    live: "p:He said **no**.",
    draft: "p:He said *no*.",
    merged: "p:He said ***no***.",
    conflicts: 0,
  },
  {
    row: "marks: mark vs replace",
    name: "bold-vs-replace",
    base: "p:He said no.",
    live: "p:He said **no**.",
    draft: "p:He said yes.",
    merged: "p:He said yes.",
    conflicts: 1,
  },
  {
    row: "marks: mark vs neighbouring edit",
    name: "link-vs-insert",
    base: "p:See the map.",
    live: "p:See the [map](a).",
    draft: "p:See the old map.",
    merged: "p:See the old [map](a).",
    conflicts: 0,
  },
  {
    row: "attrs vs text",
    name: "align-vs-text",
    base: "p:The end.",
    live: "pc:The end.",
    draft: "p:The very end.",
    merged: "pc:The very end.",
    conflicts: 0,
  },
  // Non-text blocks (atomic)
  {
    row: "figure deleted vs untouched",
    name: "figure-delete",
    base: "p:a b | fig:map | p:c d",
    live: "p:a b | p:c d",
    draft: "p:a b | fig:map | p:c d e",
    merged: "p:a b | p:c d e",
    conflicts: 0,
  },
  {
    row: "figure changed vs deleted",
    name: "figure-alt-vs-delete",
    base: "p:a b | fig:map | p:c d",
    live: "p:a b | fig:map2 | p:c d",
    draft: "p:a b | p:c d",
    merged: "p:a b | p:c d",
    conflicts: 1,
  },
  {
    row: "same rule inserted on both sides",
    name: "hr-both",
    base: "p:a b | p:c d",
    live: "p:a b | hr | p:c d",
    draft: "p:a b | hr | p:c d",
    merged: "p:a b | hr | p:c d",
    conflicts: 0,
  },
  {
    row: "edits in one container (list, quote, table)",
    name: "list-items",
    base: "list:one;two;three",
    live: "list:ONE;two;three",
    draft: "list:one;two;THREE",
    merged: "list:one;two;THREE",
    conflicts: 1,
  },
  {
    row: "edits in one container (list, quote, table)",
    name: "quote-vs-next",
    base: "quote:She said hi. | p:after",
    live: "quote:She said hello. | p:after",
    draft: "quote:She said hi. | p:after that",
    merged: "quote:She said hello. | p:after that",
    conflicts: 0,
  },
  // Scripts without spaces
  {
    row: "CJK run",
    name: "cjk-run",
    base: "p:他走了。",
    live: "p:他跑了。",
    draft: "p:她走了。",
    merged: "p:她跑了。",
    conflicts: 0,
  },
];
