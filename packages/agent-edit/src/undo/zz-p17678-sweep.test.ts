import { writeFileSync } from "node:fs";
import { it } from "vitest";
import * as Y from "yjs";
import * as baseImpl from "../__base/undo/forward-inverse.js";
import * as protoImpl from "./forward-inverse.js";

type Impl = typeof protoImpl;
type Part = protoImpl.InversePart;
function harness(impl: Impl, body: string) {
  const doc = new Y.Doc({ gc: false });
  doc.clientID = 2000;
  const p = new Y.XmlElement("paragraph"), t = new Y.XmlText();
  t.insert(0, body);
  p.insert(0, [t]);
  doc.getXmlFragment("prosemirror").insert(0, [p]);
  const v = { doc, history: [] as Part[], next: 10000 };
  const text = () => (v.doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const str = () =>
    (text().toDelta() as { insert: string; attributes?: Record<string, unknown> }[])
      .map((d) => (d.attributes && Object.keys(d.attributes).length ? `<${Object.keys(d.attributes).sort()}>${d.insert}</>` : d.insert))
      .join("");
  const plain = () => (text().toDelta() as { insert: string }[]).map((d) => d.insert).join("");
  const raw = (client: number, fn: (t: Y.XmlText) => void) => { v.doc.clientID = client; v.doc.transact(() => fn(text())); };
  const write = (fn: (t: Y.XmlText) => void): Part[] => {
    const frontier = impl.captureEditFrontier(v.doc), updates: Uint8Array[] = [], collect = (u: Uint8Array) => updates.push(u);
    v.doc.clientID = v.next++;
    v.doc.on("update", collect);
    v.doc.transact(() => fn(text()));
    v.doc.off("update", collect);
    const id = (v.history.at(-1)?.id ?? 0) + 1;
    const parts = impl.captureEditParts(v.doc, [{ frontier, update: Y.mergeUpdates(updates) }])
      .map((part, ordinal) => ({ ...part, id: id + ordinal, editId: `e${id}`, ordinal, kind: "write" as const, targets: [] }));
    v.history.push(...parts);
    return parts;
  };
  const inverse = (parts: Part[], direction: "invert" | "reapply", keep = false) => {
    const cold = new Y.Doc({ gc: false });
    Y.applyUpdate(cold, Y.encodeStateAsUpdate(v.doc));
    v.doc.destroy();
    v.doc = cold;
    const result = impl.computeInverse(v.doc, v.history, parts.map((part) => ({ part, direction })), { actionId: `a${v.history.length}`, allocateClient: () => v.next++, keepLaterWords: keep });
    for (const edit of result.edits) {
      const editId = `e${(v.history.at(-1)?.id ?? 0) + 1}`;
      for (const [ordinal, part] of edit.parts.entries()) {
        Y.applyUpdate(v.doc, part.update);
        v.history.push({ ...part, id: (v.history.at(-1)?.id ?? 0) + 1, editId, ordinal, kind: direction === "invert" ? "undo" : "redo", actionId: result.actionId });
      }
    }
    return `${result.edits.length ? "" : `skipped(${result.skipped.map((s) => s.reasons.join("/") || s.state)}) `}${str()}`;
  };
  return { v, text, str, plain, raw, write, inverse };
}
type H = ReturnType<typeof harness>;
const swap = (h: H, from: string, to: string, attrs: object = {}) => (t: Y.XmlText) => { const at = h.plain().indexOf(from); t.delete(at, from.length); t.insert(at, to, attrs); };
const type = (h: H, client: number, before: string, word: string, attrs?: object) => h.raw(client, (t) => t.insert(h.plain().indexOf(before), word, attrs));
const out: string[] = [];
function scenario(name: string, body: string, setup: (h: H) => Part[], after?: (h: H, e: Part[]) => string[]) {
  out.push(`## ${name}`);
  for (const [label, impl] of [["main ", baseImpl as unknown as Impl], ["proto", protoImpl]] as const) {
    for (const keep of [false, true]) {
      const h = harness(impl, body);
      try {
        const e = setup(h);
        const line = [`applied: ${h.str()}`];
        if (keep) line.push(`Un-Apply: ${h.inverse(e, "invert", true)}`);
        else if (after) line.push(...after(h, e));
        else line.push(`Undo: ${h.inverse(e, "invert")}`, `Redo: ${h.inverse(e, "reapply")}`, `Undo: ${h.inverse(e, "invert")}`);
        out.push(`  ${label} ${keep ? "unapply" : "card   "} | ${line.join(" | ")}`);
      } catch (error) {
        out.push(`  ${label} ${keep ? "unapply" : "card   "} | ERROR ${error instanceof Error ? error.message : error}`);
      }
    }
  }
}
const del = (h: H, client: number, what: string) => h.raw(client, (t) => t.delete(h.plain().indexOf(what), what.length));
const rep = (h: H, client: number, from: string, to: string) => h.raw(client, swap(h, from, to));
const rows: string[] = [];
let worse = 0, better = 0, same = 0, differ = 0;
it("sweep", () => {
  const base = "One small grey cat sat.";
  const ais: [string, string][] = [["small", "big"], ["small", "big black"], ["small grey", "big black"], ["small grey", "huge"], ["One small", "One big"], ["small grey cat", "big black dog"], ["One small grey cat sat.", "A big black dog ran."], ["grey cat", "red fox"]];
  const vocab = new Set((base + " big black huge One A dog ran red fox vast very so lyx").replace(/[.]/g, "").split(/\s+/));
  const glued = (s: string) => s.replace(/[.]/g, " ").split(/\s+/).filter(Boolean).some((w) => !vocab.has(w));
  for (const [from, to] of ais) {
    const words = to.replace(/[.]/g, "").split(" ");
    const ops: [string, (h: H) => void][] = [];
    for (const w of words) {
      ops.push([`replace ${w}`, (h) => h.raw(2002, swap(h, w, "vast"))]);
      ops.push([`delete ${w}`, (h) => h.raw(2002, (t) => { const at = h.plain().indexOf(w); t.delete(at, w.length + (h.plain()[at + w.length] === " " ? 1 : 0)); })]);
      ops.push([`before ${w}`, (h) => type(h, 2002, w, "very ")]);
      ops.push([`before ${w}+replace last`, (h) => { type(h, 2002, w, "very "); h.raw(2003, swap(h, words.at(-1)!, "vast")); }]);
      ops.push([`before ${w}+replace ${w}`, (h) => { type(h, 2002, w, "very "); h.raw(2003, swap(h, w, "vast")); }]);
      ops.push([`before ${w}+delete first`, (h) => { type(h, 2002, w, "so "); h.raw(2003, (t) => { const at = h.plain().indexOf(words[0]); t.delete(at, words[0].length); }); }]);
    }
    for (const [name, op] of ops) for (const keep of [false, true]) {
      const res: string[] = [];
      for (const impl of [baseImpl as unknown as Impl, protoImpl]) {
        const h = harness(impl, base);
        try { const e = h.write(swap(h, from, to)); op(h); const applied = h.plain(); res.push(applied, h.inverse(e, "invert", keep).replace(/<[^>]*>/g, "")); }
        catch (err) { res.push("?", `ERR ${err}`); }
      }
      const [applied, m, , p] = res;
      if (m === p) { same++; continue; }
      differ++;
      const gm = glued(m), gp = glued(p);
      const tag = gp && !gm ? "WORSE(glue)" : gm && !gp ? "better" : "differ";
      if (tag.startsWith("WORSE")) worse++; else if (tag === "better") better++;
      rows.push(`${tag.padEnd(12)} ${keep ? "unapply" : "card   "} ${from}->${to} | ${name} | applied: ${applied} | main: ${m} | proto: ${p}`);
    }
  }
  writeFileSync("/tmp/p17663/r-sweep.txt", [`same ${same} differ ${differ} worse(glue) ${worse} better ${better}`, ...rows].join("\n"));
});
