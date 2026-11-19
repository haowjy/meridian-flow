/**
 * Sentence-scale differential for `stands` and `sitsIn` (single-truth, stage 1). Pins implementation
 * decisions: the removal rule for membership and the round-trip rule for `stands`; the design is
 * `never-refuse/undo-single-truth.md` section 2 and 7. See `sentence-scale.md` beside it.
 *
 * Content only, no Yjs: base and draft are block lists; the pull and Apply are the package's own merge
 * and compose. Each row is an AI edit, then one to four later edits, then (60%) an Apply of one change.
 */
import { writeFileSync } from "node:fs";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import type { Node as PMNode } from "prosemirror-model";
import { expect, it } from "vitest";
import { contentMerge } from "../../src/content-merge/merge.js";
import {
  changeState,
  type ChangeMemo,
  type EditChange,
  editChanges,
  readChange,
  readChangeWhole,
  readDraft,
  takeOut,
} from "../../src/content-merge/stands.js";
import { applySpanPatches } from "../../src/diff/compose.js";
import { blocksEqual } from "../../src/diff/equal.js";
import { diffBlocks } from "../../src/diff/hunks.js";
import { composeGroups, projectReview } from "../../src/diff/review.js";

const schema = buildDocumentSchema();
type Para = { id: string; sents: string[][] };
type Model = Para[];
const toPM = (m: Model): PMNode[] =>
  m.map((p) => {
    const text = p.sents.map((s) => s.join(" ")).join(" ");
    return schema.nodes.paragraph.create({ id: p.id }, text ? [schema.text(text)] : []);
  });
const fromPM = (blocks: readonly PMNode[]): Model =>
  blocks.map((b) => {
    const sents: string[][] = [];
    let cur: string[] = [];
    for (const w of b.textContent.split(/\s+/).filter(Boolean)) {
      cur.push(w);
      if (/[.!?]$/.test(w)) {
        sents.push(cur);
        cur = [];
      }
    }
    if (cur.length) sents.push(cur);
    return { id: b.attrs.id as string, sents };
  });
const textOf = (blocks: readonly PMNode[]) => blocks.map((b) => b.textContent.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");

function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
    chance: (p: number) => next() < p,
  };
}
type R = ReturnType<typeof rng>;
const ADJ = ["old", "cold", "quiet", "broken", "narrow", "pale", "heavy", "bright", "small", "tired"];
const NOUN = ["door", "river", "lantern", "soldier", "road", "garden", "letter", "window", "blade", "child", "wind", "tower"];
const VERB = ["waited", "turned", "fell", "opened", "burned", "listened", "crossed", "watched", "moved", "slept"];
const PREP = ["by", "under", "behind", "near", "beyond", "against"];
const ADV = ["slowly", "again", "at last", "without a word", "in silence"];
const WORDS = new Set([...ADJ, ...NOUN, ...VERB, ...PREP, ..."the The and then And She He she he said at last without a word in silence".split(" "), ...ADV.flatMap((a) => a.split(" "))]);
const sentence = (r: R): string[] => {
  const shape = r.int(4);
  const np = () => `the ${r.pick(ADJ)} ${r.pick(NOUN)}`;
  const s =
    shape === 0
      ? `The ${r.pick(ADJ)} ${r.pick(NOUN)} ${r.pick(VERB)} ${r.pick(PREP)} ${np()}.`
      : shape === 1
        ? `${r.pick(["She", "He"])} ${r.pick(VERB)} ${r.pick(ADV)}, and ${np()} ${r.pick(VERB)}.`
        : shape === 2
          ? `And then ${np()} ${r.pick(VERB)}!`
          : `"The ${r.pick(NOUN)}," ${r.pick(["she", "he"])} said, "${r.pick(VERB)} ${r.pick(PREP)} ${np()}."`;
  return s.split(" ");
};
const word = (r: R, like: string): string => {
  const punct = /[^A-Za-z]+$/.exec(like)?.[0] ?? "";
  const lead = /^[^A-Za-z]+/.exec(like)?.[0] ?? "";
  return `${lead}${r.pick([...ADJ, ...NOUN, ...VERB])}${punct}`;
};

/** An op finds its place by paragraph id and the sentence's text, so the oracle can replay it without the target edit. */
type Anchor = { pid: string; sent: string };
type Sub =
  | { k: "rw"; a: Anchor; at: number; n: number; next: string[] }
  | { k: "rs"; a: Anchor; next: string[] }
  | { k: "ds"; a: Anchor }
  | { k: "is"; a: Anchor; next: string[] }
  | { k: "rp"; pid: string; next: string[][] }
  | { k: "ap"; pid: string; id: string; next: string[][] }
  | { k: "iw"; a: Anchor; at: number; next: string }
  | { k: "dw"; a: Anchor; at: number }
  | { k: "split"; a: Anchor; id: string }
  | { k: "join"; pid: string }
  | { k: "move"; pid: string };
type Op = { who: "ai" | "writer" | "live"; subs: Sub[]; name: string };

const locate = (m: Model, a: Anchor): [number, number] | null => {
  const pi = m.findIndex((p) => p.id === a.pid);
  if (pi < 0) return null;
  const si = m[pi].sents.findIndex((s) => s.join(" ") === a.sent);
  return si < 0 ? null : [pi, si];
};
const setSents = (m: Model, pi: number, sents: string[][]): Model => m.map((p, i) => (i === pi ? { ...p, sents } : p));
function applySub(m: Model, s: Sub): Model | null {
  if (s.k === "rp") {
    const pi = m.findIndex((p) => p.id === s.pid);
    return pi < 0 ? null : setSents(m, pi, s.next);
  }
  if (s.k === "ap") {
    const pi = m.findIndex((p) => p.id === s.pid);
    return pi < 0 ? null : [...m.slice(0, pi + 1), { id: s.id, sents: s.next }, ...m.slice(pi + 1)];
  }
  if (s.k === "join") {
    const pi = m.findIndex((p) => p.id === s.pid);
    if (pi < 0 || pi === m.length - 1) return null;
    return [...m.slice(0, pi), { id: m[pi].id, sents: [...m[pi].sents, ...m[pi + 1].sents] }, ...m.slice(pi + 2)];
  }
  if (s.k === "move") {
    const pi = m.findIndex((p) => p.id === s.pid);
    if (pi < 0 || m.length < 2) return null;
    const rest = m.filter((_, i) => i !== pi);
    return pi === m.length - 1 ? [m[pi], ...rest] : [...rest, m[pi]];
  }
  const at = locate(m, s.a);
  if (!at) return null;
  const [pi, si] = at;
  const sents = m[pi].sents;
  const sw = (next: string[][]) => setSents(m, pi, [...sents.slice(0, si), ...next, ...sents.slice(si + 1)]);
  switch (s.k) {
    case "rw":
      return sw([[...sents[si].slice(0, s.at), ...s.next, ...sents[si].slice(s.at + s.n)]]);
    case "rs":
      return sw([s.next]);
    case "ds":
      return sents.length < 2 ? null : sw([]);
    case "is":
      return sw([sents[si], s.next]);
    case "iw":
      return sw([[...sents[si].slice(0, s.at), s.next, ...sents[si].slice(s.at)]]);
    case "dw":
      return sents[si].length < 3 ? null : sw([sents[si].filter((_, i) => i !== s.at)]);
    case "split":
      return si === 0
        ? null
        : [...m.slice(0, pi), { id: m[pi].id, sents: sents.slice(0, si) }, { id: s.id, sents: sents.slice(si) }, ...m.slice(pi + 1)];
  }
}
const applyOp = (m: Model, op: Op): Model | null => {
  let cur = m;
  let any = false;
  for (const s of op.subs) {
    const next = applySub(cur, s);
    if (!next) return null; // all or nothing, so a row is dependent as soon as one anchor is gone
    cur = next;
    any = true;
  }
  return any ? cur : null;
};

let ids = 0;
function genAi(r: R, m: Model, aim: Anchor[] | null): Op {
  const subs: Sub[] = [];
  const n = 1 + r.int(3);
  const used = new Set<string>();
  for (let i = 0; i < n; i++) {
    const aimed = aim?.length && r.chance(0.6) ? r.pick(aim) : null;
    const p = aimed ? m.find((x) => x.id === aimed.pid) : r.pick(m);
    if (!p || used.has(p.id) || !p.sents.length) continue;
    used.add(p.id);
    const s = aimed ? (p.sents.find((x) => x.join(" ") === aimed.sent) ?? r.pick(p.sents)) : r.pick(p.sents);
    const a = { pid: p.id, sent: s.join(" ") };
    const k = r.pick(["rw", "rw", "rw", "rs", "rs", "ds", "is", "rp", "ap"] as const);
    if (k === "rw") {
      const at = r.int(s.length);
      const len = Math.min(1 + r.int(3), s.length - at);
      subs.push({ k, a, at, n: len, next: s.slice(at, at + len).map((w) => word(r, w)) });
    } else if (k === "rs" || k === "is") subs.push({ k, a, next: sentence(r) });
    else if (k === "ds") subs.push({ k, a });
    else if (k === "rp") subs.push({ k, pid: p.id, next: Array.from({ length: 1 + r.int(3) }, () => sentence(r)) });
    else subs.push({ k, pid: p.id, id: `n${ids++}`, next: Array.from({ length: 1 + r.int(2) }, () => sentence(r)) });
  }
  return { who: "ai", subs, name: `ai:${subs.map((s) => s.k).join("+")}` };
}
function genWriter(r: R, m: Model, aim: Anchor[] | null): Op {
  const aimed = aim?.length ? r.pick(aim) : null;
  const p = (aimed && m.find((x) => x.id === aimed.pid)) || r.pick(m);
  const s = (aimed && p.sents.find((x) => x.join(" ") === aimed.sent)) || r.pick(p.sents.length ? p.sents : [["x."]]);
  const a = { pid: p.id, sent: s.join(" ") };
  const k = r.pick(["rw", "rw", "iw", "dw", "is"] as const);
  const at = r.int(s.length);
  const sub: Sub =
    k === "rw"
      ? { k, a, at, n: 1, next: [word(r, s[at])] }
      : k === "iw"
        ? { k, a, at, next: r.pick([...ADJ, ...NOUN]) }
        : k === "dw"
          ? { k, a, at }
          : { k, a, next: sentence(r) };
  return { who: "writer", subs: [sub], name: `writer:${k}${aimed ? "@ai" : ""}` };
}
function genLive(r: R, m: Model): Op {
  const p = r.pick(m);
  const s = r.pick(p.sents.length ? p.sents : [["x."]]);
  const a = { pid: p.id, sent: s.join(" ") };
  const k = r.pick(["split", "join", "move", "rw"] as const);
  const at = r.int(s.length);
  const sub: Sub =
    k === "split" ? { k, a, id: `n${ids++}` } : k === "join" ? { k, pid: p.id } : k === "move" ? { k, pid: p.id } : { k, a, at, n: 1, next: [word(r, s[at])] };
  return { who: "live", subs: [sub], name: `live:${k}` };
}

/** One world: the review base (= Live) and the draft, as blocks. */
class World {
  base: PMNode[];
  draft: PMNode[];
  constructor(seed: Model) {
    this.base = toPM(seed);
    this.draft = toPM(seed);
  }
  run(op: Op): boolean {
    if (op.who === "live") {
      const next = applyOp(fromPM(this.base), op);
      if (!next) return false;
      const nb = keep(this.base, toPM(next));
      this.draft = [...contentMerge(schema, this.base, nb, this.draft).blocks];
      this.base = nb;
      return true;
    }
    const next = applyOp(fromPM(this.draft), op);
    if (!next) return false;
    this.draft = keep(this.draft, toPM(next));
    return true;
  }
}
/** Reuse the old node where a block is unchanged, as an editor or the model's write would. */
const keep = (old: readonly PMNode[], next: PMNode[]): PMNode[] =>
  next.map((b) => old.find((o) => o.attrs.id === b.attrs.id && o.textContent === b.textContent) ?? b);


const changesOf = (before: PMNode[], after: PMNode[]) => editChanges(schema, { before, after });
const groupsOf = (base: readonly PMNode[], draft: readonly PMNode[]) => projectReview(diffBlocks(base, draft));
const stateOf = (c: EditChange, text: readonly PMNode[]) => changeState(schema, c, text);

const wordsIn = (text: string) => text.match(/[A-Za-z]+/g) ?? [];
const squash = (text: string) => text.replace(/[ \t]+/g, "");
const sentencesOf = (blocks: readonly PMNode[]) => fromPM(blocks).flatMap((p) => p.sents.map((s) => s.join(" ")));

interface Row {
  seed: number;
  ops: string[];
  tally: string[];
  detail?: Record<string, unknown>;
}

/**
 * The windowed membership against the whole-document one, for every change of a row. The window may
 * name fewer groups, never more: the whole-document diff re-aligns the tail of a document when a
 * change is forced out and names a group there (`whole-only group` lines), which neither the oracle
 * nor the window counts. Both must still miss no group the edit caused.
 */
let windowNamesMore = 0;
function sitsAll(c: EditChange, base: readonly PMNode[], text: readonly PMNode[], tally: string[]) {
  const reading = readDraft(schema, base, text);
  const pending = reading.pending;
  const win = readChange(reading, c).sitsIn;
  const whole = readChangeWhole(reading, c).sitsIn;
  if ([...win].some((i) => !whole.has(i))) {
    windowNamesMore++;
    tally.push("WINDOWED names a group the whole-document read does not");
  }
  if ([...whole].some((i) => !win.has(i))) tally.push("whole-document read names a group more (tail of the document)");
  return { pending, win, whole };
}

function runRow(seedNo: number): Row | null {
  const r = rng(seedNo);
  const seed: Model = Array.from({ length: 3 + r.int(2) }, (_, i) => ({
    id: `p${i}`,
    sents: Array.from({ length: 2 + r.int(3) }, () => sentence(r)),
  }));
  const world = new World(seed);
  const ops: Op[] = [];
  const T = genAi(r, fromPM(world.draft), null);
  const before = world.draft;
  if (!world.run(T)) return null;
  const after = world.draft;
  if (blocksEqual(before, after)) return null;
  ops.push(T);
  const aim = (): Anchor[] => {
    const was = new Set(sentencesOf(before));
    return fromPM(world.draft).flatMap((p) => p.sents.filter((s) => !was.has(s.join(" "))).map((s) => ({ pid: p.id, sent: s.join(" ") })));
  };
  const later = 1 + r.int(4);
  for (let i = 0; i < later; i++) {
    const kind = r.pick(["writer", "writer", "ai", "live", "live"] as const);
    const targets = r.chance(0.35) ? aim() : null;
    const op =
      kind === "writer" ? genWriter(r, fromPM(world.draft), targets) : kind === "ai" ? genAi(r, fromPM(world.draft), targets) : genLive(r, fromPM(world.base));
    if (world.run(op)) ops.push(op);
  }
  const oracle = new World(seed);
  let independent = true;
  for (const op of ops.slice(1)) if (!oracle.run(op)) independent = false;

  const tally: string[] = [];
  const detail: Record<string, unknown> = {};
  const changes = changesOf(before, after);
  tally.push(`changes per edit: ${Math.min(changes.length, 4)}`);

  // 1. Membership: which Changes groups hold the target's changes, against the oracle (independent rows).
  const G = groupsOf(world.base, world.draft).groups;
  const sits = changes.map((c) => sitsAll(c, world.base, world.draft, tally));
  const states = changes.map((c) => stateOf(c, world.draft));
  const was = new Set(sentencesOf(before)),
    made = new Set(sentencesOf(after)),
    now = new Set(sentencesOf(world.draft));
  const intact = [...made].filter((x) => !was.has(x)).every((x) => now.has(x)) && [...was].filter((x) => !made.has(x)).every((x) => !now.has(x));
  if (intact)
    changes.forEach((_, i) => {
      tally.push(`intact change reads ${states[i]}`);
    });
  const member = new Set(sits.flatMap((s) => [...s.win]));
  const memberWhole = new Set(sits.flatMap((s) => [...s.whole]));
  if (independent) {
    const theirs = new Set(projectReview(diffBlocks(oracle.base, oracle.draft)).groups.map((g) => `${g.kind}|${g.excerpt.removed}|${g.excerpt.inserted}`));
    const groups = groupsOf(world.base, world.draft).groups;
    const expect = groups.flatMap((g, i) => (theirs.has(`${g.kind}|${g.excerpt.removed}|${g.excerpt.inserted}`) ? [] : [i]));
    const missed = expect.filter((i) => !member.has(i));
    const extra = [...member].filter((i) => !expect.includes(i));
    tally.push(`membership (indep, ${states.every((x) => x === "stands") ? "all stand" : "some altered or out"}): ${missed.length ? "MISSED a group" : extra.length ? "named an extra group" : "exact"}`);
    const missedRow = expect.filter((i) => !memberWhole.has(i));
    const wholeExtra = [...memberWhole].filter((i) => !expect.includes(i));
    tally.push(`WHOLE-doc membership (indep, ${states.every((x) => x === "stands") ? "all stand" : "some altered or out"}): ${missedRow.length ? "MISSED a group" : wholeExtra.length ? "named an extra group" : "exact"}`);
    if (missed.length) detail.missedRow = { missed: missed.map((i) => [groups[i].excerpt]), ops: ops.map((o) => o.name), start: textOf(world.draft), base: textOf(world.base), changes: changes.map((c) => [textOf([...c.before]), textOf([...c.after])]), states, oracle: textOf(oracle.draft) };
    if (missed.length || extra.length) detail.membership = { missed: missed.map((i) => groups[i].excerpt), extra: extra.map((i) => groups[i].excerpt) };
  }
  // 2. A proposed change shows in Changes.
  changes.forEach((_, i) => {
    const sat = sits[i].win.size > 0;
    tally.push(`state ${states[i] === "altered" ? "altered" : states[i]} / ${sat ? "in Changes" : "not in Changes"}`);
  });

  // 3. Partial Apply of one group, `carried` by membership, then the card's Undo of what is still proposed.
  let base = world.base;
  const carried = new Set<number>();
  if (G.length && r.chance(0.6)) {
    const proj = groupsOf(world.base, world.draft);
    const pick = r.int(G.length);
    changes.forEach((_, i) => {
      if (sits[i].win.has(pick)) carried.add(i);
    });
    base = applySpanPatches(world.base, composeGroups(schema, proj, [proj.groups[pick].id], "apply"), "base");
    tally.push(`apply: carried ${carried.size ? "some of the target" : "none of the target"}`);
    changes.forEach((c, i) => {
      const sat = sitsAll(c, base, world.draft, tally).win.size > 0;
      if (carried.has(i)) tally.push(`after apply, carried change: ${sat ? "STILL in a pending group" : "not pending"}`);
      else if (states[i] === "stands") tally.push(`after apply, proposed change: ${sat ? "in Changes" : "NOT in Changes (Undo would write a reverse proposal)"}`);
    });
  }
  // 4. Undo: every change that is proposed and not carried.
  let draft = world.draft;
  const pendingBefore = groupsOf(base, draft).groups.length;
  let acted = 0;
  changes.forEach((c, i) => {
    if (carried.has(i) || stateOf(c, draft) !== "stands") return;
    draft = takeOut(schema, c, draft);
    acted++;
  });
  if (changes.some((c, i) => !carried.has(i) && stateOf(c, draft) === "stands")) {
    tally.push("AFTER UNDO a change still reads stands");
    detail.stillStands = { ops: ops.map((o) => o.name), before: textOf(world.draft), after: textOf(draft), changes: changes.map((c) => [textOf([...c.before]), textOf([...c.after])]), carried: [...carried] };
  }
  if (changes.some((c, i) => !carried.has(i) && stateOf(c, draft) === "stands" && !blocksEqual(takeOut(schema, c, draft), draft))) tally.push("SECOND PRESS would change the text");
  if (acted && carried.size && groupsOf(base, draft).groups.length > pendingBefore) tally.push("UNDO ADDED a pending change after a partial Apply");
  const text = textOf(draft);
  if (wordsIn(text).some((t) => !WORDS.has(t))) tally.push("GLUED or cut word after Undo");
  if (independent && !carried.size) {
    const right = squash(text) === squash(textOf(oracle.draft));
    const all = states.every((s) => s === "stands");
    tally.push(`indep, no apply: ${all ? "all proposed" : "some altered or out"} -> ${right ? "right" : acted ? "differs" : "stayed"}`);
  }
  return { seed: seedNo, ops: ops.map((o) => o.name), tally, detail: Object.keys(detail).length ? { ...detail, start: textOf(world.draft), states } : undefined };
}

const ROWS = Number(process.env.ROWS ?? 4000);

it("sentence-scale differential", { timeout: 1_800_000 }, () => {
  const table: Record<string, number> = {};
  const samples: Record<string, Row[]> = {};
  let rows = 0;
  for (let s = Number(process.env.SEED ?? 1); rows < ROWS && s < ROWS * 4 + Number(process.env.SEED ?? 1); s++) {
    let row: Row | null;
    try {
      row = runRow(s);
    } catch (error) {
      row = { seed: s, ops: [], tally: [`THROW ${(error as Error).message.slice(0, 80)}`] };
    }
    if (!row) continue;
    rows++;
    for (const t of new Set(row.tally)) {
      table[t] = (table[t] ?? 0) + 1;
      const list = (samples[t] ??= []);
      if (/AFTER UNDO|SECOND|MISSED|NOT in|state stands \/ not in/.test(t) && list.length < 5) list.push(row);
    }
  }
  const lines = Object.entries(table)
    .sort()
    .map(([k, n]) => `${String(n).padStart(6)}  ${k}`);
  const out = `rows=${rows} (a row counts once per line it hits)\n${lines.join("\n")}\n`;
  process.stdout.write(out);
  if (process.env.OUT) {
    writeFileSync(`${process.env.OUT}.txt`, out);
    writeFileSync(`${process.env.OUT}.json`, JSON.stringify(samples, null, 1));
  }
  expect(windowNamesMore, "windowed membership is inside the whole-document membership").toBe(0);
  const hit = (re: RegExp) => Object.entries(table).filter(([k]) => re.test(k)).reduce((n, [, v]) => n + v, 0);
  expect(hit(/MISSED/), "membership misses no change").toBe(0);
  expect(hit(/THROW|GLUED|AFTER UNDO|SECOND PRESS|NOT in Changes|state stands \/ not in Changes/), "Undo is safe and every proposed change is in Changes").toBe(0);
});

/**
 * The card's read of a draft with many pending AI changes: every change's state and membership, as
 * the server reads them. Nodes are rebuilt from JSON for every read, as a request reads them from the
 * draft and the receipts, so the diff's memo on node identity never helps. Cold is a first read;
 * "after a write elsewhere" and "after a write inside one change" reread with the memos kept.
 */
it("bench: the read for a card", { timeout: 600_000 }, () => {
  const r = rng(7);
  const out: string[] = [];
  for (const paras of [50, 200]) {
    const seed: Model = Array.from({ length: paras }, (_, i) => ({ id: `p${i}`, sents: Array.from({ length: 12 }, () => sentence(r)) }));
    let text = toPM(seed);
    const words = textOf(text).split(/\s+/).length;
    const changes: EditChange[] = [];
    for (let i = 0; i < 40; i++) {
      const op = genAi(r, fromPM(text), null);
      const next = applyOp(fromPM(text), op);
      if (!next) continue;
      const after = keep(text, toPM(next));
      changes.push(...changesOf(text, after));
      text = after;
    }
    const fresh = (blocks: readonly PMNode[]) => blocks.map((b) => schema.nodeFromJSON(b.toJSON()) as PMNode);
    const cs = changes.map((c) => ({ before: fresh(c.before), after: fresh(c.after) }));
    const memos = new Map<number, ChangeMemo>();
    const pass = (label: string, edit: (blocks: PMNode[]) => PMNode[]) => {
      const base = fresh(toPM(seed));
      const t = edit(fresh(text));
      const start = performance.now();
      const reading = readDraft(schema, base, t);
      const diffMs = performance.now() - start;
      cs.forEach((c, i) => memos.set(i, readChange(reading, c, memos.get(i)).memo));
      return `${label} ${(performance.now() - start).toFixed(0)} ms (Changes diff ${diffMs.toFixed(0)})`;
    };
    const typed = (index: number) => (blocks: PMNode[]) =>
      blocks.map((b, i) => (i === index ? schema.nodes.paragraph.create(b.attrs, [schema.text(`${b.textContent} zz`)]) : b));
    const cold = pass("cold", (b) => b);
    const elsewhere = pass("again after a write in the last paragraph", typed(text.length - 1));
    const inside = pass("again after a write inside the first change", typed(text.findIndex((b) => b.attrs.id === changes[0].after[Math.min(1, changes[0].after.length - 1)].attrs.id)));
    out.push(`${words} words, ${changes.length} changes: ${cold}; ${elsewhere}; ${inside}`);
  }
  process.stdout.write(`${out.join("\n")}\n`);
});
