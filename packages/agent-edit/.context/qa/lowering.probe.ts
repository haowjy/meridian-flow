// Hand-run probe of how `lowerBlock` lowers real AI paragraph rewrites to Loro text ops.
// Run: pnpm --filter @meridian/agent-edit exec tsx .context/qa/lowering.probe.ts [--examples]
import { readFileSync } from "node:fs";
import {
  configureDoc,
  inText,
  readInline,
  replaceText,
  TEXT_KEY,
  type TextRules,
  unitEditors,
  wordDiff as reviewWordDiff,
} from "@meridian/document-model";
import { inlineNodes, inlineOf, shapeSchemaOf } from "@meridian/loro-prosemirror";
import { buildDocumentSchema } from "@meridian/prosemirror-schema";
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, makeDiff } from "@sanity/diff-match-patch";
import { LoroDoc, type LoroText, UndoManager } from "loro-crdt";
import { diffKeys } from "../../src/diff/tokens.js";
import { lowerBlock } from "../../src/resolver/lower-block.js";

type E1 =
  | { kind: "insert"; at: number; text: string }
  | { kind: "retype"; from: number; to: number; text: string };
/** A paragraph `base0`, the writer's edit `e1` making `base1`, and the model's rewrite `ai` of it. */
type Case = { id: string; base0: string; e1: E1; base1: string; ai: string };
type Typing = "lead" | "trail";

const schema = buildDocumentSchema();
const shape = shapeSchemaOf(schema);
const rules: TextRules = {
  rule: shape.node("paragraph") as TextRules["rule"],
  shape,
  visibleComment: () => true,
};
const COMMENT = "comment_";
const configured = (doc: LoroDoc) => configureDoc(doc, shape);
const text = <T>(doc: LoroDoc, use: (t: LoroText) => T) => inText(doc, use);
const plain = (doc: LoroDoc) => text(doc, (t) => t.toString());

// ---------- the write, as agent-edit plans and applies it ----------

/** The paragraph the model's view holds: its text and its comments, as readers read them. */
const viewNode = (view: LoroDoc) =>
  schema.nodes.paragraph.create(
    null,
    inlineNodes(schema, readInline(view, rules.rule, shape, rules.visibleComment)),
  );

/**
 * The model's copy at the view, its write planned there (authors read from the view) and applied
 * through the one text write; returns the update and its op count.
 */
function aiWrite(view: LoroDoc, ai: string) {
  const editors = unitEditors(view, rules.rule, shape);
  const ops = lowerBlock(viewNode(view), schema.nodes.paragraph.create(null, schema.text(ai)), {
    authors: () => (unit) => editors[unit],
  });
  const from = view.oplogVersion();
  const copy = configured(view.fork());
  copy.setPeerId(3n);
  for (const op of ops) {
    if (op.kind !== "text" || op.formats.length > 0) throw new Error(`unexpected op ${op.kind}`);
    for (const s of [...op.splices].sort((x, y) => y.from - x.from))
      replaceText(copy, rules, s.from, s.to, inlineOf(s.content));
  }
  copy.commit();
  const update = copy.export({ mode: "update", from });
  const json = copy.exportJsonUpdates(from, copy.oplogVersion());
  copy.free();
  return { update, ops: json.changes.reduce((n, ch) => n + ch.ops.length, 0) };
}

// ---------- the writer ----------

function writerDoc(c: Case) {
  const origin = configured(new LoroDoc());
  origin.setPeerId(1n);
  text(origin, (t) => t.insert(0, c.base0));
  origin.commit();
  const writer = configured(new LoroDoc());
  writer.setPeerId(2n);
  writer.import(origin.export({ mode: "snapshot" }));
  origin.free();
  return writer;
}

/** The writer's edit before the read: ` phrase` typed after a word (`lead`) or `phrase ` before the next. */
function writerE1(writer: LoroDoc, e1: E1, typing: Typing) {
  text(writer, (t) => {
    if (e1.kind === "insert")
      typing === "lead" ? t.insert(e1.at, e1.text) : t.insert(e1.at + 1, `${e1.text.slice(1)} `);
    else {
      t.delete(e1.from, e1.to - e1.from);
      t.insert(e1.from, e1.text);
    }
  });
  writer.commit();
}

/** The model's view: a copy checked out at the read, as `RoomDocs.at` makes it. */
function viewOf(writer: LoroDoc) {
  const view = configured(writer.fork());
  view.checkout(writer.frontiers());
  view.setDetachedEditing(true);
  return view;
}

// ---------- word helpers ----------

const words = (s: string) => s.split(/\s+/).filter(Boolean);
type Tok = { w: string; start: number; end: number };
const tokens = (s: string): Tok[] =>
  [...s.matchAll(/\S+/g)].map((m) => ({
    w: m[0],
    start: m.index ?? 0,
    end: (m.index ?? 0) + m[0].length,
  }));
const isLetter = (ch: string | undefined) => !!ch && /[\p{L}’']/u.test(ch);

/** Each token of `a`: the token of `b` it equals (-1 if none), and the replacement span it sits in. */
function align(a: string, b: string) {
  const ta = tokens(a);
  const tb = tokens(b);
  const map = new Int32Array(ta.length).fill(-1);
  const repl: Array<[number, number] | null> = new Array(ta.length).fill(null);
  let i = 0;
  let j = 0;
  const ops = diffKeys(
    ta.map((t) => t.w),
    tb.map((t) => t.w),
  );
  for (let k = 0; k < ops.length; k++) {
    const [op, n] = ops[k];
    if (op === DIFF_EQUAL) {
      for (let x = 0; x < n; x++) map[i + x] = j + x;
      i += n;
      j += n;
    } else if (op === DIFF_DELETE) {
      const next = ops[k + 1];
      const ins = next && next[0] === DIFF_INSERT ? next[1] : 0;
      const span: [number, number] | null = ins > 0 ? [tb[j].start, tb[j + ins - 1].end] : null;
      for (let x = 0; x < n; x++) repl[i + x] = span;
      i += n;
      if (ins > 0) {
        j += ins;
        k++;
      }
    } else j += n;
  }
  return { ta, tb, map, repl };
}

/** Words of `x` that `y` lacks, counted. */
function missing(x: string, y: string) {
  const bag = new Map<string, number>();
  const wx = words(x);
  let i = 0;
  for (const [op, n] of diffKeys(wx, words(y))) {
    if (op === DIFF_DELETE)
      for (let k = 0; k < n; k++) bag.set(wx[i + k], (bag.get(wx[i + k]) ?? 0) + 1);
    if (op !== DIFF_INSERT) i += n;
  }
  return bag;
}

/** AI words that lose some characters but not all in `final`, or get letters inside. */
function cutWords(ai: string, final: string) {
  const dead = new Uint8Array(ai.length);
  const insertedAt = new Set<number>();
  let at = 0;
  for (const [op, piece] of makeDiff(ai, final, { timeout: 0 })) {
    if (op === DIFF_DELETE) for (let k = 0; k < piece.length; k++) dead[at + k] = 1;
    if (op === DIFF_INSERT && /\S/.test(piece)) insertedAt.add(at);
    if (op !== DIFF_INSERT) at += piece.length;
  }
  let cut = 0;
  for (const t of tokens(ai)) {
    let killed = 0;
    for (let k = t.start; k < t.end; k++) killed += dead[k];
    const pierced = [...insertedAt].some((p) => p > t.start && p < t.end);
    if ((killed > 0 && killed < t.end - t.start) || pierced) cut++;
  }
  return cut;
}

// ---------- scenarios ----------

/** What Ctrl+Z should give: the AI's text with E1 taken out only where the AI kept it word for word. */
function idealUndo(c: Case): string {
  const { ta, map, tb } = align(c.base1, c.ai);
  const start = c.e1.kind === "insert" ? c.e1.at + 1 : c.e1.from;
  const end = c.e1.kind === "insert" ? c.e1.at + c.e1.text.length : c.e1.from + c.e1.text.length;
  const mine = ta.map((t, i) => ({ t, i })).filter(({ t }) => t.start < end && t.end > start);
  if (mine.length === 0 || mine.some(({ i }) => map[i] < 0)) return c.ai;
  const delta = tb[map[mine[0].i]].start - mine[0].t.start;
  if (mine.some(({ i, t }) => tb[map[i]].start - t.start !== delta)) return c.ai;
  if (c.e1.kind === "insert")
    return c.ai.slice(0, c.e1.at + delta) + c.ai.slice(c.e1.at + delta + c.e1.text.length);
  return c.ai.slice(0, start + delta) + c.base0.slice(c.e1.from, c.e1.to) + c.ai.slice(end + delta);
}

/** The writer's E1, the AI's write, then Ctrl+Z (Loro's `UndoManager`, no gate). */
function holes(c: Case, typing: Typing) {
  const writer = writerDoc(c);
  const undo = new UndoManager(writer, { mergeInterval: 0, maxUndoSteps: 100 });
  writerE1(writer, c.e1, typing);
  if (plain(writer) !== c.base1) throw new Error(`${c.id}: base1 mismatch`);
  const view = viewOf(writer);
  const { update, ops } = aiWrite(view, c.ai);
  view.free();
  writer.import(update);
  if (plain(writer) !== c.ai) throw new Error(`${c.id}: AI text mismatch`);
  undo.undo();
  const final = plain(writer);
  const ideal = idealUndo(c);
  const want = missing(c.ai, ideal);
  let broken = 0;
  for (const [w, n] of missing(c.ai, final)) broken += Math.max(0, n - (want.get(w) ?? 0));
  const outcome =
    final === ideal ? "as asked" : final === c.ai ? "no-op" : broken > 0 ? "broke" : "other";
  undo.free();
  writer.free();
  return { broken, outcome, cut: cutWords(c.ai, final), final, ideal, ops };
}

let seed = 5;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

/** Up to 6 words the AI keeps and 6 it changes (to a non-empty replacement), with where each should end up. */
function commentPlan(c: Case) {
  const { ta, map, repl, tb } = align(c.base1, c.ai);
  const core = (t: Tok) => {
    const m = /[\p{L}’']+/u.exec(t.w);
    return m
      ? { start: t.start + (m.index ?? 0), end: t.start + (m.index ?? 0) + m[0].length }
      : null;
  };
  const kept: Array<{ start: number; end: number; expect: [number, number] }> = [];
  const changed: Array<{ start: number; end: number; span: [number, number] }> = [];
  ta.forEach((t, i) => {
    const r = core(t);
    if (!r || r.end - r.start < 3) return;
    if (map[i] >= 0) {
      const off = r.start - t.start;
      const bt = tb[map[i]];
      kept.push({ ...r, expect: [bt.start + off, bt.start + off + (r.end - r.start)] });
    } else if (repl[i]) changed.push({ ...r, span: repl[i] as [number, number] });
  });
  const pick = <T>(xs: T[], n: number) => {
    const copy = [...xs];
    const out: T[] = [];
    while (out.length < n && copy.length)
      out.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
    return out;
  };
  return { kept: pick(kept, 6), changed: pick(changed, 6) };
}

function markRanges(t: LoroText, key: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = 0;
  for (const d of t.toDelta()) {
    const len = (d.insert as string).length;
    if (d.attributes?.[key]) {
      const last = out.at(-1);
      if (last && last[1] === at) last[1] = at + len;
      else out.push([at, at + len]);
    }
    at += len;
  }
  return out;
}

/**
 * Comments on the planned words before the read, then the AI's write. A kept-word comment is
 * right when it covers exactly that word; a changed-word comment is `whole` when it covers whole
 * words inside that word's replacement, `fragment` when it covers part of a word or leaks out.
 */
function comments(c: Case, typing: Typing, plan: ReturnType<typeof commentPlan>) {
  const writer = writerDoc(c);
  writerE1(writer, c.e1, typing);
  const all = [...plan.kept, ...plan.changed];
  text(writer, (t) => {
    for (const [k, w] of all.entries()) t.mark({ start: w.start, end: w.end }, `${COMMENT}${k}`, true);
  });
  writer.commit();
  const view = viewOf(writer);
  writer.import(aiWrite(view, c.ai).update);
  view.free();
  const merged = plain(writer);
  const out = { keptRight: 0, kept: plan.kept.length, whole: 0, fragment: 0, lost: 0 };
  const astray: string[] = [];
  text(writer, (t) => {
    plan.kept.forEach((w, k) => {
      const r = markRanges(t, `${COMMENT}${k}`);
      if (r.length === 1 && r[0][0] === w.expect[0] && r[0][1] === w.expect[1]) out.keptRight++;
    });
    plan.changed.forEach((w, k) => {
      const r = markRanges(t, `${COMMENT}${plan.kept.length + k}`);
      const word = c.base1.slice(w.start, w.end);
      const into = c.ai.slice(w.span[0], w.span[1]);
      if (r.length === 0) {
        out.lost++;
        astray.push(`lost ${word} → ${into}`);
      } else if (
        r.every(
          ([s, e]) =>
            !isLetter(merged[s - 1]) && !isLetter(merged[e]) && s >= w.span[0] && e <= w.span[1],
        )
      )
        out.whole++;
      else {
        out.fragment++;
        astray.push(`fragment ${word} → ${into}: ${r.map(([s, e]) => merged.slice(s, e)).join(" | ")}`);
      }
    });
  });
  writer.free();
  return { ...out, astray };
}

const W_WORDS = ["gravely", "briskly", "tonight", "perhaps", "meanwhile", "suddenly"];

function concurrentPlan(c: Case) {
  const ts = tokens(c.base1);
  const spots = ts
    .map((t, i) => ({ t, i }))
    .filter(({ t, i }) => i > 0 && i < ts.length - 1 && /\p{L}$/u.test(t.w));
  const { t, i } = spots[Math.floor(rand() * spots.length)];
  const word = W_WORDS.find((x) => !new RegExp(`\\b${x}\\b`, "i").test(c.base1 + c.ai)) as string;
  return { at: t.end, anchor: i, word };
}

/** The writer types one word after the read and before the write lands. */
function concurrent(c: Case, typing: Typing, plan: ReturnType<typeof concurrentPlan>) {
  const writer = writerDoc(c);
  writerE1(writer, c.e1, typing);
  const view = viewOf(writer);
  const { update } = aiWrite(view, c.ai);
  view.free();
  text(writer, (t) =>
    typing === "lead" ? t.insert(plan.at, ` ${plan.word}`) : t.insert(plan.at + 1, `${plan.word} `),
  );
  writer.commit();
  writer.import(update);
  const merged = plain(writer);
  writer.free();

  const { map, tb, repl } = align(c.base1, c.ai);
  let idealAt: number;
  let inPlace: (pos: number) => boolean;
  if (map[plan.anchor] >= 0) {
    idealAt = tb[map[plan.anchor]].end;
    inPlace = (pos) => pos === idealAt;
  } else if (repl[plan.anchor]) {
    const [s, e] = repl[plan.anchor] as [number, number];
    idealAt = e;
    inPlace = (pos) => pos >= s && pos <= e;
  } else {
    let k = plan.anchor;
    while (k >= 0 && map[k] < 0) k--;
    idealAt = k >= 0 ? tb[map[k]].end : 0;
    inPlace = (pos) => pos === idealAt;
  }
  const ideal = `${c.ai.slice(0, idealAt)} ${plan.word}${c.ai.slice(idealAt)}`;
  const at =
    merged.indexOf(` ${plan.word} `) >= 0
      ? merged.indexOf(` ${plan.word} `)
      : merged.indexOf(plan.word) - 1;
  const glued = isLetter(merged[at + plan.word.length + 1]) || isLetter(merged[at]);
  const withoutWord = merged.slice(0, at) + merged.slice(at + plan.word.length + 1);
  const landed = glued
    ? "glued"
    : withoutWord === c.ai && inPlace(at)
      ? "in place"
      : "displaced";
  // Review changes paints `wordDiff(reference, draft)`: compare its words with the ideal's.
  const highlight = (s: string) => {
    const bag = new Map<string, number>();
    for (const part of reviewWordDiff(c.base1, s))
      if (part.kind !== "same")
        for (const w of words(part.text))
          bag.set(`${part.kind}:${w}`, (bag.get(`${part.kind}:${w}`) ?? 0) + 1);
    return bag;
  };
  const got = highlight(merged);
  const want = highlight(ideal);
  let reviewOff = 0;
  for (const k of new Set([...got.keys(), ...want.keys()]))
    reviewOff += Math.abs((got.get(k) ?? 0) - (want.get(k) ?? 0));
  return { landed, reviewOff, merged, ideal };
}

// ---------- run ----------

const cases: Case[] = JSON.parse(
  readFileSync(new URL("./lowering-cases.json", import.meta.url), "utf8"),
);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
console.log(
  "typing | Ctrl+Z breaks AI words | AI words broken | as asked | no-op | kept-word comments right | changed-word comments whole/fragment/lost | concurrent in place/glued/displaced | review off | ops",
);
for (const typing of ["lead", "trail"] as const) {
  seed = 5;
  const rows = cases.map((c) => {
    const cplan = commentPlan(c);
    const wplan = concurrentPlan(c);
    return {
      id: c.id,
      holes: holes(c, typing),
      comments: comments(c, typing, cplan),
      concurrent: concurrent(c, typing, wplan),
    };
  });
  const land = (k: string) => rows.filter((r) => r.concurrent.landed === k).length;
  console.log(
    [
      typing === "lead" ? '" word"' : '"word "',
      `${rows.filter((r) => r.holes.broken > 0).length}/${rows.length}`,
      sum(rows.map((r) => r.holes.broken)),
      rows.filter((r) => r.holes.outcome === "as asked").length,
      rows.filter((r) => r.holes.outcome === "no-op").length,
      `${sum(rows.map((r) => r.comments.keptRight))}/${sum(rows.map((r) => r.comments.kept))}`,
      ["whole", "fragment", "lost"]
        .map((k) => sum(rows.map((r) => r.comments[k as "whole"])))
        .join("/"),
      `${land("in place")}/${land("glued")}/${land("displaced")}`,
      rows.filter((r) => r.concurrent.reviewOff > 0).length,
      (sum(rows.map((r) => r.holes.ops)) / rows.length).toFixed(1),
    ].join(" | "),
  );
  if (process.argv.includes("--examples"))
    for (const r of rows) {
      if (r.holes.broken > 0)
        console.log(`  [${r.id}] Ctrl+Z\n    ideal: ${r.holes.ideal}\n    final: ${r.holes.final}`);
      for (const line of r.comments.astray) console.log(`  [${r.id}] comment ${line}`);
      if (r.concurrent.landed !== "in place")
        console.log(
          `  [${r.id}] concurrent ${r.concurrent.landed}\n    ideal:  ${r.concurrent.ideal}\n    merged: ${r.concurrent.merged}`,
        );
    }
}
