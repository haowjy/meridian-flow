import { writeFileSync } from "node:fs";
import { it } from "vitest";
import * as Y from "yjs";
import * as baseImpl from "../__base/undo/forward-inverse.js";
import * as protoImpl from "./forward-inverse.js";

type Impl = typeof protoImpl;
type Part = protoImpl.InversePart;
type Ch = { ch: string; a: string };
const KEEP = !!process.env.KEEP;

function harness(impl: Impl) {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 2000;
  const p = new Y.XmlElement("paragraph"),
    t = new Y.XmlText();
  p.insert(0, [t]);
  doc.getXmlFragment("prosemirror").insert(0, [p]);
  const v = { doc, history: [] as Part[], next: 10000 };
  const text = () =>
    (v.doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const chars = (): Ch[] =>
    (text().toDelta() as { insert: string; attributes?: Record<string, unknown> }[]).flatMap((d) =>
      typeof d.insert === "string"
        ? [...d.insert].map((ch) => ({ ch, a: JSON.stringify(Object.entries(d.attributes ?? {}).sort()) }))
        : [],
    );
  const str = () => chars().map((c) => c.ch).join("");
  const raw = (client: number, fn: (t: Y.XmlText) => void) => {
    v.doc.clientID = client;
    v.doc.transact(() => fn(text()));
  };
  const write = (fn: (t: Y.XmlText) => void): Part[] => {
    const frontier = impl.captureEditFrontier(v.doc),
      updates: Uint8Array[] = [],
      collect = (u: Uint8Array) => updates.push(u);
    v.doc.clientID = v.next++;
    v.doc.on("update", collect);
    try {
      v.doc.transact(() => fn(text()));
    } finally {
      v.doc.off("update", collect);
    }
    const id = (v.history.at(-1)?.id ?? 0) + 1;
    const parts = impl
      .captureEditParts(v.doc, [{ frontier, update: Y.mergeUpdates(updates) }])
      .map((part, ordinal) => ({ ...part, id: id + ordinal, editId: `e${id}`, ordinal, kind: "write" as const, targets: [] }));
    v.history.push(...parts);
    return parts;
  };
  const inverse = (parts: Part[], direction: "invert" | "reapply", keep = false) => {
    const cold = new Y.Doc({ gc: false });
    Y.applyUpdate(cold, Y.encodeStateAsUpdate(v.doc));
    v.doc.destroy();
    v.doc = cold;
    const result = impl.computeInverse(v.doc, v.history, parts.map((part) => ({ part, direction })), {
      actionId: `a${v.history.length}`,
      allocateClient: () => v.next++,
      keepLaterWords: keep,
    });
    for (const edit of result.edits) {
      const editId = `e${(v.history.at(-1)?.id ?? 0) + 1}`;
      for (const [ordinal, part] of edit.parts.entries()) {
        Y.applyUpdate(v.doc, part.update);
        v.history.push({ ...part, id: (v.history.at(-1)?.id ?? 0) + 1, editId, ordinal, kind: direction === "invert" ? "undo" : "redo", actionId: result.actionId });
      }
    }
    return result.edits.length;
  };
  return { v, text, chars, str, raw, write, inverse };
}
const lcg = (seed: number) => <T>(xs: readonly T[]): T => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  lcgState.seed = seed;
  return xs[Math.floor((seed / 4294967296) * xs.length)];
};
const lcgState = { seed: 0 };
interface Outcome { error?: string; checks: Record<string, boolean>; trace: string[]; final?: string }
type Totals = Record<string, { proto: number; base: number; worse: number; rows: number }>;
function tally(totals: Totals, worse: unknown[], r: unknown, base: Outcome, proto: Outcome) {
  for (const [label, ok] of Object.entries(proto.checks)) {
    const kind = label.split(":")[1];
    totals[kind] ??= { proto: 0, base: 0, worse: 0, rows: 0 };
    const t = totals[kind];
    t.rows++;
    if (!ok) t.proto++;
    if (base.checks[label] === false) t.base++;
    if (!ok && base.checks[label] !== false) {
      t.worse++;
      if (worse.length < 25) worse.push({ label, r, proto: proto.trace, base: base.trace });
    }
  }
}

/** One part replaces two words; the writer acts on each AI word and on the text between them. */
const ACT = ["none", "none", "before", "after", "replace", "delete", "before+replace", "before+delete"] as const;
const MID = ["none", "none", "rewrite", "delete", "space-then-delete", "type"] as const;
const PAST2 = ["none", "none", "typo-after-1", "typo-after-2", "toggle-2"] as const;
const MARKS2 = ["none", "none", "boldall", "bold-2"] as const;
interface MultiRow { n: number; a1: (typeof ACT)[number]; a2: (typeof ACT)[number]; mid: (typeof MID)[number]; past: (typeof PAST2)[number]; marks: (typeof MARKS2)[number]; order: "12" | "21"; third: boolean }
function runMulti(impl: Impl, r: MultiRow): Outcome {
  const h = harness(impl), checks: Record<string, boolean> = {}, trace: string[] = [];
  try {
    h.raw(2000, (t) => t.insert(0, "One red dog small cat."));
    if (r.marks === "boldall") h.raw(2000, (t) => t.format(0, 22, { bold: true }));
    if (r.marks === "bold-2") h.raw(2000, (t) => t.format(12, 5, { bold: true }));
    if (r.past === "typo-after-1") { h.raw(2001, (t) => t.insert(7, "s")); h.raw(2001, (t) => t.delete(7, 1)); }
    if (r.past === "typo-after-2") { h.raw(2001, (t) => t.insert(17, "s")); h.raw(2001, (t) => t.delete(17, 1)); }
    if (r.past === "toggle-2") { h.raw(2001, (t) => t.format(13, 1, { italic: true })); h.raw(2001, (t) => t.format(13, 1, { italic: null })); }
    const attrsAt = (t: Y.XmlText, at: number) => {
      let seen = 0;
      for (const d of t.toDelta() as { insert: string; attributes?: object }[]) {
        if (seen + d.insert.length > at) return d.attributes ?? {};
        seen += d.insert.length;
      }
      return {};
    };
    const e1 = h.write((t) => {
      const swap = (word: string, to: string) => {
        const at = h.str().indexOf(word), attrs = attrsAt(t, at);
        t.delete(at, word.length);
        t.insert(at, to, attrs);
      };
      if (r.order === "21") { swap("small", "big"); swap("red", "blue"); } else { swap("red", "blue"); swap("small", "big"); }
      if (r.third) t.insert(0, "Then ");
    });
    // writer
    const act = (ai: string, old: string, mine: string, a: (typeof ACT)[number], client: number): string => {
      let before = "";
      const at = () => h.str().indexOf(ai);
      if (a.startsWith("before")) { h.raw(client, (t) => t.insert(at(), "very ")); before = "very "; }
      if (a === "after") { h.raw(client, (t) => t.insert(at() + ai.length, "ish")); return `${old}ish`; }
      if (a.endsWith("replace")) { const i = at(); h.raw(client, (t) => { t.delete(i, ai.length); t.insert(i, mine); }); return `${before}${mine}`; }
      if (a.endsWith("delete")) { const i = at(); h.raw(client, (t) => t.delete(i, ai.length)); return `${before}${old}`; }
      return `${before}${old}`;
    };
    const w1 = act("blue", "red", "pale", r.a1, 2002);
    const w2 = act("big", "small", "huge", r.a2, 2003);
    let mid = " dog ";
    const dogAt = () => h.str().indexOf(" dog ");
    if (r.mid === "rewrite") { const i = dogAt(); h.raw(2004, (t) => { t.delete(i + 1, 3); t.insert(i + 1, "fox"); }); mid = " fox "; }
    if (r.mid === "delete") { const i = dogAt(); h.raw(2004, (t) => t.delete(i + 1, 4)); mid = " "; }
    if (r.mid === "space-then-delete") { const i = dogAt(); h.raw(2004, (t) => t.insert(i, " ")); h.raw(2004, (t) => t.delete(i + 1, 5)); mid = " "; }
    if (r.mid === "type") { const i = dogAt(); h.raw(2004, (t) => t.insert(i + 1, "old ")); mid = " old dog "; }
    const applied = h.chars(), appliedStr = h.str();
    trace.push(`applied: ${appliedStr}`);
    const want = `One ${w1}${mid}${w2} cat.`;
    const judge = (label: string) => {
      const s = h.str();
      trace.push(`${label}: ${s} (want ${want})`);
      checks[`${label}:position`] = s === want;
      checks[`${label}:kept`] = [...s].sort().join("") === [...want].sort().join("");
      // A word the writer replaced must not come back; one they left must come back whole.
      for (const [old, a] of [["red", r.a1], ["small", r.a2]] as const) {
        if (a.endsWith("replace")) checks[`${label}-${old}:doubled`] = !s.includes(old);
        else checks[`${label}-${old}:whole`] = s.includes(old);
      }
      checks[`${label}:writer-words`] = ["very ", "ish", "pale", "huge", "fox", "old "].every((w) => !appliedStr.includes(w) || s.includes(w));
    };
    const did = h.inverse(e1, "invert", KEEP);
    judge("undo");
    if (KEEP) {
      checks["undo:safe"] = did ? checks["undo:position"] : h.str() === appliedStr;
      checks["undo:reversed"] = did > 0;
      return { checks, trace };
    }
    h.inverse(e1, "reapply");
    trace.push(`redo: ${h.str()}`);
    checks["redo:text"] = h.str() === appliedStr;
    checks["redo:exact"] = JSON.stringify(h.chars()) === JSON.stringify(applied);
    h.inverse(e1, "invert");
    judge("undo2");
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), checks, trace };
  }
  return { checks, trace };
}

it("multi", () => {
  const pick = lcg(1591), totals: Totals = {}, worse: unknown[] = [], samples: unknown[] = [];
  let errors = 0;
  const N = Number(process.env.MULTI_ROWS ?? 3000);
  for (let n = 0; n < N; n++) {
    const r: MultiRow = { n, a1: pick(ACT), a2: pick(ACT), mid: pick(MID), past: pick(PAST2), marks: pick(MARKS2), order: pick(["12", "21"] as const), third: pick([false, false, true]) };
    const base = runMulti(baseImpl as unknown as Impl, r), proto = runMulti(protoImpl, r);
    if (proto.error || base.error) { errors++; if (samples.length < 10) samples.push({ r, proto: proto.error, base: base.error, trace: proto.trace }); continue; }
    tally(totals, worse, r, base, proto);
  }
  writeFileSync(`/tmp/p17663/multi${KEEP ? "-keep" : ""}.json`, JSON.stringify({ rows: N, errors, totals, worse, samples, protoFails: {} }, null, 1));
}, 600000);

/** Parts that format, alone or with a replacement, and a writer typing inside the formatted range. */
const FMT = ["bold", "italic", "unbold"] as const;
const RANGE = ["word", "word+next", "sentence"] as const;
const WITH = ["format-only", "format-only", "replace-in-range", "replace-elsewhere"] as const;
const TYPE = ["end-of-word", "inside-range", "before-word", "outside", "none"] as const;
const WM = ["inherit", "plain", "italic"] as const;
interface FmtRow { n: number; fmt: (typeof FMT)[number]; range: (typeof RANGE)[number]; with: (typeof WITH)[number]; type: (typeof TYPE)[number]; wm: (typeof WM)[number] }
function runFormat(impl: Impl, r: FmtRow): Outcome {
  const h = harness(impl), checks: Record<string, boolean> = {}, trace: string[] = [];
  try {
    h.raw(2000, (t) => t.insert(0, "One small cat sat."));
    if (r.fmt === "unbold") h.raw(2000, (t) => t.format(0, 18, { bold: true }));
    const [from, len] = r.range === "word" ? [4, 5] : r.range === "word+next" ? [4, 9] : [0, 18];
    const value = r.fmt === "bold" ? { bold: true } : r.fmt === "italic" ? { italic: true } : { bold: null };
    let word = "small";
    const e1 = h.write((t) => {
      t.format(from, len, value);
      if (r.with === "replace-in-range") { t.delete(4, 5); t.insert(4, "big", r.fmt === "unbold" ? {} : r.fmt === "bold" ? { bold: true } : { italic: true }); word = "big"; }
      if (r.with === "replace-elsewhere") { const i = h.str().indexOf("sat"); t.delete(i, 3); t.insert(i, "lay", r.fmt === "unbold" ? { bold: true } : {}); }
    });
    const wattrs = r.wm === "inherit" ? undefined : r.wm === "plain" ? {} : { italic: true };
    const at = 4;
    if (r.type === "end-of-word") h.raw(2002, (t) => t.insert(at + word.length, "est", wattrs));
    if (r.type === "inside-range") h.raw(2002, (t) => t.insert(at + word.length + 1, "black ", wattrs));
    if (r.type === "before-word") h.raw(2002, (t) => t.insert(at, "very ", wattrs));
    if (r.type === "outside") h.raw(2002, (t) => t.insert(h.str().length, " Good", wattrs));
    const applied = h.str();
    trace.push(`applied: ${JSON.stringify(h.chars().map((c) => c.ch + c.a).join(""))}`);
    const did = h.inverse(e1, "invert", KEEP);
    const final = JSON.stringify(h.chars());
    trace.push(`undo did=${did}: ${h.str()}`);
    if (KEEP) return { checks, trace, final: `${did}|${final}` };
    h.inverse(e1, "reapply");
    const redo = JSON.stringify(h.chars());
    h.inverse(e1, "invert");
    checks["redo:text"] = true;
    void applied;
    return { checks, trace, final: `${final}|${redo}|${JSON.stringify(h.chars())}` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), checks, trace };
  }
}
it("format", () => {
  const out: Record<string, { rows: number; same: number; differ: number }> = {}, differ: unknown[] = [];
  let errors = 0, n = 0;
  for (const fmt of FMT) for (const range of RANGE) for (const w of WITH) for (const type of TYPE) for (const wm of WM) {
    const r: FmtRow = { n: n++, fmt, range, with: w, type, wm };
    const base = runFormat(baseImpl as unknown as Impl, r), proto = runFormat(protoImpl, r);
    if (proto.error || base.error) { errors++; differ.push({ r, proto: proto.error, base: base.error }); continue; }
    const kind = w === "format-only" ? "format-only" : w;
    out[kind] ??= { rows: 0, same: 0, differ: 0 };
    out[kind].rows++;
    if (proto.final === base.final) out[kind].same++;
    else { out[kind].differ++; differ.push({ r, proto: proto.trace, base: base.trace }); }
  }
  writeFileSync(`/tmp/p17663/format${KEEP ? "-keep" : ""}.json`, JSON.stringify({ errors, out, differ }, null, 1));
}, 600000);
