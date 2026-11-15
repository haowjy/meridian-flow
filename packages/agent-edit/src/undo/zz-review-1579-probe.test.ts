import { writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import * as Y from "yjs";
import {
  captureEditFrontier,
  captureEditParts,
  classifyEditParts,
  computeInverse,
  type InversePart,
} from "./forward-inverse.js";

type View = { doc: Y.Doc; history: InversePart[]; nextClient: number };
function paragraph(body: string): Y.XmlElement {
  const p = new Y.XmlElement("paragraph"),
    t = new Y.XmlText();
  t.insert(0, body);
  p.insert(0, [t]);
  return p;
}
function base(lines: string[]): View {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 2000;
  doc.getXmlFragment("prosemirror").insert(0, lines.map(paragraph));
  return { doc, history: [], nextClient: 10000 };
}
function cold(v: View): void {
  const doc = new Y.Doc({ gc: false });
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(v.doc));
  v.doc.destroy();
  v.doc = doc;
}
const ps = (v: View) => v.doc.getXmlFragment("prosemirror").toArray() as Y.XmlElement[];
const text = (v: View, i = 0) => ps(v)[i].get(0) as Y.XmlText;
const content = (v: View) =>
  ps(v).map((p) =>
    (p.get(0) as Y.XmlText)
      .toDelta()
      .map((x: { insert: unknown }) => (typeof x.insert === "string" ? x.insert : ""))
      .join(""),
  );
const _xml = (v: View) => v.doc.getXmlFragment("prosemirror").toString();
function swap(v: View, from: string, to: string, i = 0): void {
  const t = text(v, i),
    at = content(v)[i].indexOf(from);
  if (at < 0) throw new Error(`Missing ${from}`);
  t.delete(at, from.length);
  t.insert(at, to);
}
function write(v: View, fns: ((v: View) => void)[]): InversePart[] {
  const receipts = fns.map((fn) => {
    const frontier = captureEditFrontier(v.doc),
      updates: Uint8Array[] = [],
      collect = (u: Uint8Array) => updates.push(u);
    v.doc.clientID = v.nextClient++;
    v.doc.on("update", collect);
    try {
      v.doc.transact(() => fn(v));
    } finally {
      v.doc.off("update", collect);
    }
    return { frontier, update: Y.mergeUpdates(updates) };
  });
  const id = (v.history.at(-1)?.id ?? 0) + 1,
    parts = captureEditParts(v.doc, receipts).map((p, ordinal) => ({
      ...p,
      id: id + ordinal,
      editId: `e${id}`,
      ordinal,
      kind: "write" as const,
      targets: [],
    }));
  v.history.push(...parts);
  return parts;
}
function inverse(v: View, parts: InversePart[], direction: "invert" | "reapply"): number {
  cold(v);
  const result = computeInverse(
    v.doc,
    v.history,
    parts.map((part) => ({ part, direction })),
    { actionId: `a${v.history.length}`, allocateClient: () => v.nextClient++ },
  );
  for (const edit of result.edits) {
    const editId = `e${(v.history.at(-1)?.id ?? 0) + 1}`;
    for (const [ordinal, p] of edit.parts.entries()) {
      Y.applyUpdate(v.doc, p.update);
      v.history.push({
        ...p,
        id: (v.history.at(-1)?.id ?? 0) + 1,
        editId,
        ordinal,
        kind: direction === "invert" ? "undo" : "redo",
        actionId: result.actionId,
      });
    }
  }
  return result.edits.reduce((n, edit) => n + edit.parts.length, 0);
}
const states = (v: View, parts: InversePart[]) =>
  classifyEditParts(v.doc, v.history, parts).map((p) => p.state);
const delta = (v: View, i = 0) => JSON.stringify(text(v, i).toDelta());
function typeAs(v: View, fn: (v: View) => void) {
  // writer typing recorded as a non-AI write in history
  const frontier = captureEditFrontier(v.doc),
    updates: Uint8Array[] = [],
    c = (u: Uint8Array) => updates.push(u);
  v.doc.clientID = 2000;
  v.doc.on("update", c);
  v.doc.transact(() => fn(v));
  v.doc.off("update", c);
  const later = captureEditParts(v.doc, [{ update: Y.mergeUpdates(updates), frontier }])[0];
  const id = (v.history.at(-1)?.id ?? 0) + 1;
  v.history.push({ ...later, id, editId: `w${id}`, ordinal: 0, kind: "write", targets: [] });
}
const at = (v: View, s: string, i = 0) => content(v)[i].indexOf(s);
const log: string[] = [];
const rec = (label: string, v: View) =>
  log.push(`${label}: ${JSON.stringify(content(v))} ${delta(v)}`);
import * as B from "../__base/undo/forward-inverse.js";
import * as P from "../__prev/undo/forward-inverse.js";
const impls = { build: { captureEditFrontier, captureEditParts, classifyEditParts, computeInverse }, main: B, prev: P } as const;
type Impl = (typeof impls)["build"];
function run(name: string, impl: Impl, steps: (h: H) => void) { const h = new H(impl); steps(h); out.push(`${name} [${impl === impls.main ? "main" : "build"}]: ${h.log.join(" | ")}`); }
const out: string[] = [];
class H {
  v: View; log: string[] = []; constructor(public impl: Impl) { this.v = base(["One small cat."]); }
  set(s: string) { const t = text(this.v); t.delete(0, t.length); t.insert(0, s); }
  ai(fns: ((v: View) => void)[]) {
    const v = this.v, impl = this.impl;
    const frontier = impl.captureEditFrontier(v.doc), updates: Uint8Array[] = [], c = (u: Uint8Array) => updates.push(u);
    v.doc.clientID = v.nextClient++; v.doc.on("update", c);
    v.doc.transact(() => { for (const f of fns) f(v); }); v.doc.off("update", c);
    const id = (v.history.at(-1)?.id ?? 0) + 1;
    const parts = impl.captureEditParts(v.doc, [{ frontier, update: Y.mergeUpdates(updates) }]).map((p, ordinal) => ({ ...p, id: id + ordinal, editId: `e${id}`, ordinal, kind: "write" as const, targets: [] }));
    v.history.push(...parts); this.log.push(`ai: ${content(v)[0]}`); return parts;
  }
  type(fn: (t: Y.XmlText, s: string) => void, label = "typed") {
    const v = this.v, impl = this.impl;
    const frontier = impl.captureEditFrontier(v.doc), updates: Uint8Array[] = [], c = (u: Uint8Array) => updates.push(u);
    v.doc.clientID = 2000; v.doc.on("update", c); try { v.doc.transact(() => fn(text(v), content(v)[0])); } catch { this.log.push("type-n/a"); v.doc.off("update", c); return; } v.doc.off("update", c);
    const later = impl.captureEditParts(v.doc, [{ update: Y.mergeUpdates(updates), frontier }])[0];
    const id = (v.history.at(-1)?.id ?? 0) + 1;
    if (later) v.history.push({ ...later, id, editId: `w${id}`, ordinal: 0, kind: "write", targets: [] });
    this.log.push(`${label}: ${content(v)[0]}`);
  }
  inv(parts: InversePart[], d: "invert" | "reapply", label = d) {
    const v = this.v; cold(v);
    try {
      const r = this.impl.computeInverse(v.doc, v.history, parts.map((part) => ({ part, direction: d })), { actionId: `a${v.history.length}`, allocateClient: () => v.nextClient++, keepLaterWords: !!process.env.KEEP });
      let n = 0;
      for (const edit of r.edits) { const editId = `e${(v.history.at(-1)?.id ?? 0) + 1}`; for (const [ordinal, p] of edit.parts.entries()) { n++; Y.applyUpdate(v.doc, p.update); v.history.push({ ...p, id: (v.history.at(-1)?.id ?? 0) + 1, editId, ordinal, kind: d === "invert" ? "undo" : "redo", actionId: r.actionId }); } }
      this.log.push(`${label}(${n}${r.skipped.length ? " skipped:" + r.skipped.map((s) => s.reasons.join("/")).join(",") : ""}): ${content(v)[0]} ${delta(v)}`);
    } catch (e) { this.log.push(`${label} threw ${(e as Error).message}`); }
  }
}
const ix = (s: string, w: string) => { const i = s.indexOf(w); if (i < 0) throw new Error(`no ${w} in ${s}`); return i; };
describe("p17564", () => {
  for (const impl of Object.values(impls)) {
    it("S1 writer rewrote the word before, then replaced AI word", () => run("S1", impl, (h) => {
      const e = h.ai([(v) => text(v).insert(0, "Then "), (v) => swap(v, "small", "big")]);
      h.type((t, s) => t.insert(ix(s, "One"), "Two "));
      h.type((t, s) => t.delete(ix(s, "One "), 4));
      h.type((t, s) => { t.delete(ix(s, "big"), 3); t.insert(ix(s, "big"), "huge"); });
      h.inv(e, "invert");
    }));
    it("P1 astra A large", () => run("P1", impl, (h) => {
      const e = h.ai([(v) => swap(v, "small", "big"), (v) => text(v).insert(0, "very ")]);
      h.type((t, s) => t.insert(ix(s, "One"), "A "));
      h.type((t, s) => t.delete(ix(s, "One "), 4));
      h.type((t, s) => { t.delete(ix(s, "big"), 3); t.insert(ix(s, "big"), "large"); });
      h.inv(e, "invert"); h.inv(e, "reapply"); h.inv(e, "invert");
    }));
    it("P2 astra bold very", () => run("P2", impl, (h) => {
      const e = h.ai([(v) => { const t = text(v), at = ix(content(v)[0], "small"); t.delete(at, 5); t.insert(at, "big", { bold: true }); }]);
      h.type((t, s) => t.insert(ix(s, "big"), "very ", { bold: true }));
      h.inv(e, "invert");
    }));
    it("S1b writer replaced AI word only (control)", () => run("S1b", impl, (h) => {
      const e = h.ai([(v) => text(v).insert(0, "Then "), (v) => swap(v, "small", "big")]);
      h.type((t, s) => { t.delete(ix(s, "big"), 3); t.insert(ix(s, "big"), "huge"); });
      h.inv(e, "invert");
    }));
    it("S2 bold writer typing (format stops typing left of tombstone)", () => run("S2", impl, (h) => {
      const e = h.ai([(v) => swap(v, "small", "big"), (v) => text(v).insert(content(v)[0].length, " Then.")]);
      h.type((t, s) => { t.delete(ix(s, "big"), 3); t.insert(ix(s, "big"), "huge"); });
      h.inv(e, "invert");
    }));
    it("A design-review seq A", () => run("A", impl, (h) => {
      h.set("One small cat sat.");
      const e = h.ai([(v) => { const t = text(v); t.delete(ix(content(v)[0], "small "), 6); t.insert(ix(content(v)[0], "sat"), "very "); }]);
      h.type((t, s) => { t.delete(ix(s, "cat "), 4); t.insert(ix(s, "very"), "dog "); });
      h.inv(e, "invert"); h.inv(e, "reapply"); h.inv(e, "invert");
    }));
    it("R brief + Undo Redo Undo + typing between", () => run("R", impl, (h) => {
      const e = h.ai([(v) => swap(v, "small", "big")]);
      h.type((t, s) => t.insert(ix(s, "big"), "very "));
      h.inv(e, "invert"); h.type((t, s) => t.insert(ix(s, "small"), "so "));
      h.inv(e, "reapply"); h.type((t, s) => t.insert(ix(s, "big"), "quite "));
      h.inv(e, "invert"); h.inv(e, "reapply");
    }));
    it("M writer bolds own typing, original italic", () => run("M", impl, (h) => {
      h.set("One small cat."); text(h.v).format(4, 5, { italic: true });
      const e = h.ai([(v) => swap(v, "small", "big")]);
      h.type((t, s) => t.insert(ix(s, "big"), "very ", { bold: true }));
      h.inv(e, "invert"); h.inv(e, "reapply"); h.inv(e, "invert");
    }));
    it("W writer deleted the restored word after Undo, Redo", () => run("W", impl, (h) => {
      const e = h.ai([(v) => swap(v, "small", "big")]);
      h.type((t, s) => t.insert(ix(s, "big"), "very "));
      h.inv(e, "invert");
      h.type((t, s) => { t.delete(ix(s, "small"), 5); t.insert(ix(s, " cat"), "tiny"); });
      h.inv(e, "reapply");
    }));
  }
  it("zz", () => writeFileSync(process.env.KEEP ? "/tmp/p17663/r-probe-keep.txt" : "/tmp/p17663/r-probe.txt", out.join("\n")));
});
describe("cost", () => {
  it("many runs", () => {
    const rows: string[] = [];
    for (const [name, impl] of Object.entries(impls)) {
      const h = new H(impl);
      h.set(Array.from({ length: 2000 }, (_, i) => `q${i}z`).join(" ") + ".");
      const e = h.ai([(v) => { for (let i = 0; i < 2000; i += 10) swap(v, `q${i + 5}z`, `n${i + 5}z`); }]);
      h.type((t, s) => { for (let i = 0; i < 2000; i += 10) { const cur = content(h.v)[0]; t.insert(cur.indexOf(`n${i + 5}z`), "x "); } });
      const times: number[] = [];
      for (let r = 0; r < 21; r++) { const doc = new Y.Doc({ gc: false }); Y.applyUpdate(doc, Y.encodeStateAsUpdate(h.v.doc));
        const t0 = performance.now(); const res = impl.computeInverse(doc, h.v.history, e.map((part) => ({ part, direction: "invert" as const })), { actionId: "a", allocateClient: () => 900000 + r }); times.push(performance.now() - t0);
        if (r === 0) { for (const ed of res.edits) for (const p of ed.parts) Y.applyUpdate(doc, p.update); rows.push(`${name} sample: ${(doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0).toString().slice(0, 80)}`); } }
      times.sort((a, b) => a - b); rows.push(`${name} invert 200 runs median ${times[10].toFixed(1)}ms min ${times[0].toFixed(1)}`);
      const ct: number[] = []; for (let r = 0; r < 21; r++) { const t0 = performance.now(); impl.classifyEditParts(h.v.doc, h.v.history, h.v.history); ct.push(performance.now() - t0); }
      ct.sort((a, b) => a - b); rows.push(`${name} classify median ${ct[10].toFixed(1)}ms`);
    }
    writeFileSync("/tmp/p17663/r-cost.txt", rows.join("\n"));
  }, 120000);
});
