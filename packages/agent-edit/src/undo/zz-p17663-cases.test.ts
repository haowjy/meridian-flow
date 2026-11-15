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
it("cases", () => {
  scenario("brief: small->big, 'very ' before", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very "); return e; });
  scenario("brief, typing between each step", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very "); return e; }, (h, e) => {
    const l = [`Undo: ${h.inverse(e, "invert")}`]; type(h, 2003, "small", "so ");
    l.push(`Redo: ${h.inverse(e, "reapply")}`); type(h, 2004, "big", "oh ");
    l.push(`Undo: ${h.inverse(e, "invert")}`, `Redo: ${h.inverse(e, "reapply")}`); return l; });
  scenario("#1569 blocking: two turns, undo turn 2, type, undo turn 1", "One small cat.", (h) => { const e1 = h.write(swap(h, "small", "big")); const e2 = h.write(swap(h, "big", "huge")); h.inverse(e2, "invert"); type(h, 2002, "big", "very "); return e1; });
  scenario("#1569 astra P1: italic toggled inside the word", "One small cat.", (h) => { h.raw(2001, (t) => t.format(6, 1, { italic: true })); h.raw(2001, (t) => t.format(6, 1, { italic: null })); const e = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very ", {}); return e; });
  scenario("#1569 astra P2: wholly bold word", "One small cat.", (h) => { h.raw(2000, (t) => t.format(4, 5, { bold: true })); const e = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very ", {}); return e; });
  scenario("design review A: delete 'small ', insert 'very ' before 'sat', writer rewrites cat->dog", "One small cat sat.", (h) => { const e = h.write((t) => { t.delete(4, 6); t.insert(h.plain().indexOf("sat"), "very "); }); h.raw(2002, (t) => { const at = h.plain().indexOf("cat "); t.delete(at, 4); t.insert(at, "dog "); }); return e; });
  scenario("#1579 review S1: 'Then ' + small->big; writer 'Two ', deletes 'One ', big->huge", "One small cat.", (h) => { const e = h.write((t) => { swap(h, "small", "big")(t); t.insert(0, "Then "); }); type(h, 2002, "One", "Two "); h.raw(2002, (t) => t.delete(h.plain().indexOf("One "), 4)); h.raw(2002, swap(h, "big", "large" === "x" ? "" : "huge")); return e; });
  scenario("#1579 astra P1: small->big + 'very ' at start; writer 'A ', deletes 'One ', big->large", "One small cat.", (h) => { const e = h.write((t) => { t.delete(4, 5); t.insert(4, "big", {}); t.insert(0, "very ", {}); }); h.raw(2002, (t) => t.insert(5, "A ", {})); h.raw(2002, (t) => t.delete(7, 4)); h.raw(2002, swap(h, "big", "large")); return e; });
  scenario("#1579 astra P2: bold AI word, writer's bold 'very ' before", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big", { bold: true })); type(h, 2002, "big", "very ", { bold: true }); return e; });
  scenario("#1579 control: bold AI word, plain 'very ' before", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big", { bold: true })); type(h, 2002, "big", "very ", {}); return e; });
  scenario("#1579 re-review multi: small->big, red->blue; writer big->huge, ' ' before ' dog ', deletes ' dog '", "One red dog small cat.", (h) => { const e = h.write((t) => { t.delete(12, 5); t.insert(12, "big", {}); t.delete(4, 3); t.insert(4, "blue", {}); }); h.raw(2002, swap(h, "big", "huge")); const at = h.plain().indexOf(" dog "); h.raw(2002, (t) => t.insert(at, " ", {})); h.raw(2002, (t) => t.delete(at + 1, 5)); return e; });
  scenario("multi: both words stand, 'very ' before each", "One red dog small cat.", (h) => { const e = h.write((t) => { swap(h, "small", "big")(t); swap(h, "red", "blue")(t); }); type(h, 2002, "blue", "very "); type(h, 2003, "big", "quite "); return e; });
  scenario("re-review F1: AI bolds 'small', writer types 'est' at its end", "One small cat.", (h) => { const e = h.write((t) => t.format(4, 5, { bold: true })); h.raw(2002, (t) => t.insert(9, "est")); return e; });
  scenario("re-review F2: AI bolds 'small cat', writer types 'black ' inside", "One small cat.", (h) => { const e = h.write((t) => t.format(4, 9, { bold: true })); h.raw(2002, (t) => t.insert(10, "black ")); return e; });
  scenario("re-review F7: bold paragraph, AI unbolds 'small', writer types 'est'", "One small cat.", (h) => { h.raw(2000, (t) => t.format(0, 14, { bold: true })); const e = h.write((t) => t.format(4, 5, { bold: null })); h.raw(2002, (t) => t.insert(9, "est")); return e; });
  scenario("hazard: writer typed before the AI's word, then deleted it", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very "); h.raw(2002, (t) => t.delete(h.plain().indexOf("big"), 3)); return e; });
  scenario("hazard: writer typed before the AI's word, then replaced it", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very "); h.raw(2002, swap(h, "big", "huge")); return e; });
  scenario("hazard owned-suffix: turn 0 deleted 'ish', turn 1 small->big, 'very ' before; undo 1 then 0", "One smallish cat.", (h) => { h.write((t) => t.delete(9, 3)); const e = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very "); return e; }, (h, e) => {
    const p0 = h.v.history.filter((p) => p.editId === "e1");
    return [`Undo t1: ${h.inverse(e, "invert")}`, `Undo t0: ${h.inverse(p0, "invert")}`, `Redo t0: ${h.inverse(p0, "reapply")}`, `Redo t1: ${h.inverse(e, "reapply")}`]; });
  scenario("hazard typo-after: writer backspaced 's' after 'small' before the AI edit", "One small cat.", (h) => { h.raw(2001, (t) => t.insert(9, "s")); h.raw(2001, (t) => t.delete(9, 1)); const e = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very "); return e; });
  scenario("hazard typo-inside: writer backspaced 'k' inside 'small' before the AI edit", "One small cat.", (h) => { h.raw(2001, (t) => t.insert(6, "k")); h.raw(2001, (t) => t.delete(6, 1)); const e = h.write(swap(h, "small", "big")); type(h, 2002, "big", "very "); return e; });
  scenario("generator row 55: 'very ' before blue; big deleted; ' ' typed before ' dog ', ' dog ' deleted", "One red dog small cat.", (h) => { const e = h.write((t) => { swap(h, "small", "big")(t); swap(h, "red", "blue")(t); }); type(h, 2002, "blue", "very "); h.raw(2003, (t) => t.delete(h.plain().indexOf("big"), 3)); const at = h.plain().indexOf(" dog "); h.raw(2004, (t) => t.insert(at, " ")); h.raw(2004, (t) => t.delete(at + 1, 5)); return e; });
  scenario("re-review B1: 'very ' before blue; ' so' before big; big->huge", "One red dog small cat.", (h) => { const e = h.write((t) => { swap(h, "red", "blue")(t); swap(h, "small", "big")(t); }); type(h, 2002, "blue", "very "); type(h, 2002, "big", " so"); h.raw(2003, swap(h, "big", "huge")); return e; });
  scenario("review B1: small->'big black', writer replaces 'big' with 'huge'", "One small cat.", (h) => { const e = h.write(swap(h, "small", "big black")); h.raw(2003, swap(h, "big", "huge")); return e; });
  scenario("concurrent peer typed after 'small' without seeing the AI edit", "One small cat.", (h) => {
    const peer = new Y.Doc({ gc: false }); Y.applyUpdate(peer, Y.encodeStateAsUpdate(h.v.doc)); peer.clientID = Number(process.env.PEER ?? 500);
    ((peer.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText).insert(9, "er");
    const e = h.write(swap(h, "small", "big")); Y.applyUpdate(h.v.doc, Y.encodeStateAsUpdate(peer)); return e; });
  writeFileSync(`/tmp/p17663/cases${process.env.CROSS_UNOWNED ? "-C" : "-S"}.txt`, out.join("\n"));
});
