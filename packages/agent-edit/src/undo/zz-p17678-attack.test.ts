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
it("attack", () => {
  // Find windows carry the model's context: one splice "One small" -> "One big".
  scenario("A1 window with leading context, 'very ' before big", "One small cat.", (h) => { const e = h.write(swap(h, "One small", "One big")); type(h, 2002, "big", "very "); return e; });
  scenario("A2 window 'small cat'->'big cat', 'very ' before big", "One small cat.", (h) => { const e = h.write(swap(h, "small cat", "big cat")); type(h, 2002, "big", "very "); return e; });
  scenario("A3 window ' small'->' big' (leading space), 'very ' before big", "One small cat.", (h) => { const e = h.write(swap(h, " small", " big")); type(h, 2002, "big", "very "); return e; });
  // Partial replacement of the AI's text by the writer: the exemption.
  scenario("A4 writer replaces 'bi' with 'hu'", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big")); rep(h, 2002, "bi", "hu"); return e; });
  scenario("A5 run 'small grey'->'big black', writer replaces big with huge", "One small grey cat.", (h) => { const e = h.write(swap(h, "small grey", "big black")); rep(h, 2002, "big", "huge"); return e; });
  scenario("A6 run 'small grey'->'big black', writer deletes 'big '", "One small grey cat.", (h) => { const e = h.write(swap(h, "small grey", "big black")); del(h, 2002, "big "); return e; });
  scenario("A7 run 'small grey'->'big black', writer replaces 'black' with 'white'", "One small grey cat.", (h) => { const e = h.write(swap(h, "small grey", "big black")); rep(h, 2002, "black", "white"); return e; });
  scenario("A8 sentence window, writer rewrites first word", "One small cat. Two dogs.", (h) => { const e = h.write(swap(h, "One small cat.", "A big cat.")); rep(h, 2002, "A", "The"); return e; });
  scenario("A9 sentence window, writer replaces its first half", "One small cat. Two dogs.", (h) => { const e = h.write(swap(h, "One small cat.", "A big cat sat.")); rep(h, 2002, "A big", "My"); return e; });
  scenario("A10 'very ' before big, then writer deletes 'b'", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very "); del(h, 2002, "b"); return e; });
  scenario("A11 writer types before big, then replaces 'bi' with 'hu'", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very "); rep(h, 2002, "bi", "hu"); return e; });
  scenario("A12 run 'small grey'->'big black', 'very ' before big, writer replaces black with white", "One small grey cat.", (h) => { const e = h.write(swap(h, "small grey", "big black")); type(h, 2002, "big", "very "); rep(h, 2002, "black", "white"); return e; });
  scenario("A13 writer types 'so ' before ' black'", "One small grey cat.", (h) => { const e = h.write(swap(h, "small grey", "big black")); h.raw(2002, (t) => t.insert(h.plain().indexOf("black"), "so ")); return e; });
  scenario("A14 'small'->'big', writer deletes 'big' and types 'huge' then 'very ' before huge", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big")); rep(h, 2002, "big", "huge"); type(h, 2002, "huge", "very "); return e; });
  scenario("A15 'small'->'big black', writer replaces 'big' with 'huge'", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big black")); rep(h, 2002, "big", "huge"); return e; });
  scenario("A16 'small'->'big black', writer selects 'big ' and types 'vast '", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big black")); rep(h, 2002, "big ", "vast "); return e; });
  scenario("A17 'small grey'->'big black', writer selects 'big ' and types 'vast '", "One small grey cat.", (h) => { const e = h.write(swap(h, "small grey", "big black")); rep(h, 2002, "big ", "vast "); return e; });
  scenario("A18 bold 'very ' typed before plain big", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very ", { bold: true }); return e; });
  scenario("A19 Undo, writer replaces 'small' in restored 'small grey', Redo", "One small grey cat.", (h) => { const e = h.write(swap(h, "small grey", "big black")); type(h, 2002, "big", "very "); return e; }, (h, e) => { const l = [`Undo: ${h.inverse(e, "invert")}`]; rep(h, 2003, "small", "tiny"); l.push(`typed: ${h.str()}`, `Redo: ${h.inverse(e, "reapply")}`, `Undo: ${h.inverse(e, "invert")}`); return l; });
  scenario("A20 two turns typed before each, undo newer then older", "One small cat.", (h) => { const e1 = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very "); const e2 = h.write(swap(h, "big", "huge")); type(h, 2003, "huge", "so "); return [...e1, ...e2]; }, (h, e) => { const l = [`Undo2: ${h.inverse([e[1]], "invert")}`, `Undo1: ${h.inverse([e[0]], "invert")}`]; return l; });
  scenario("A21 two turns typed before each, undo older while newer stands", "One small cat.", (h) => { const e1 = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very "); const e2 = h.write(swap(h, "big", "huge")); type(h, 2003, "huge", "so "); return [...e1, ...e2]; }, (h, e) => [`Undo1: ${h.inverse([e[0]], "invert")}`, `Undo2: ${h.inverse([e[1]], "invert")}`]);
  scenario("A22 writer deletes 'b' of 'big black' and types 'B'", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big black")); rep(h, 2002, "b", "B"); return e; });
  scenario("A23 'very ' before big, writer replaces black with white, deletes big", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big black")); type(h, 2002, "big", "very "); rep(h, 2003, "black", "white"); h.raw(2003, (t) => t.delete(h.plain().indexOf("big "), 4)); return e; });
  scenario("D1 boldall, AI plain big, writer types very (inherit) and bolds it", "One small cat.", (h) => { h.raw(2000, (t) => t.format(0, 14, { bold: true })); const e = h.write((t) => { t.delete(4, 5); t.insert(4, "big", {}); }); h.raw(2002, (t) => t.insert(4, "very ")); h.raw(2002, (t) => t.format(4, 5, { bold: true })); return e; });
  scenario("D2 boldall, AI plain big, writer types very (inherit)", "One small cat.", (h) => { h.raw(2000, (t) => t.format(0, 14, { bold: true })); const e = h.write((t) => { t.delete(4, 5); t.insert(4, "big", {}); }); h.raw(2002, (t) => t.insert(4, "very ")); return e; });
  writeFileSync("/tmp/p17663/r-attack.txt", out.join("\n"));
});
