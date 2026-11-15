/**
 * Exact-content cold-replica matrix for durable forward inverses (POC 1 and 2 contracts).
 *
 * Pins implementation decisions (rewrite or delete these cases when one changes):
 * - Forward inverses use lineage admission and inverse-of-inverse replay (kb/wiki/architecture/collaboration/agent-editing-and-reversal.md#reversal-is-a-forward-edit)
 */
import { writeFileSync } from "node:fs";
import { it } from "vitest";
import * as Y from "yjs";
import {
  admitInverseReceipt,
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
const xml = (v: View) => v.doc.getXmlFragment("prosemirror").toString();
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


const BASE = "One small cat.";
const shapes: Record<string, (v: View) => void> = {
  "whole window": (v) => { text(v).delete(0, 9); text(v).insert(0, "One big"); },
  "changed word": (v) => { text(v).delete(4, 5); text(v).insert(4, "big"); },
};
const ins = (at: string, s: string) => (v: View) => { const i = content(v)[0].indexOf(at); for (const [k, ch] of [...s].entries()) text(v).insert(i + k, ch); };
const rm = (s: string) => (v: View) => { const i = content(v)[0].indexOf(s); text(v).delete(i, s.length); };
const writers: Record<string, ((v: View) => void)[]> = {
  "nothing": [],
  "types 'very ' before big": [ins("big", "very ")],
  "One -> Once (types ce after On, deletes e)": [rm("e big"), ins(" big", "ce")],
  "types X inside One": [ins("ne big", "X")],
  "deletes 'One '": [rm("One ")],
  "types 'Then ' before One": [ins("One", "Then ")],
  "types ' fat' after big": [ins(" cat", " fat")],
  "retypes One as A": [rm("One"), ins(" big", "A")],
  "deletes big": [rm("big ")],
};
it("undo shapes", () => {
  const lines: string[] = [];
  for (const [wname, fns] of Object.entries(writers)) {
    lines.push(`## writer ${wname}`);
    for (const [sname, shape] of Object.entries(shapes)) {
      const v = base([BASE]);
      const e = write(v, [shape]);
      for (const fn of fns) write(v, [fn]);
      const mid = content(v)[0];
      let out: string;
      try { inverse(v, e, "invert"); out = content(v)[0]; } catch (err) { out = `THROWS ${(err as Error).message}`; }
      let redo = "";
      try { inverse(v, e, "reapply"); redo = content(v)[0]; } catch (err) { redo = `THROWS ${(err as Error).message}`; }
      lines.push(`  ${sname}: after writer "${mid}" | Undo "${out}" | Redo "${redo}"`);
    }
  }
  writeFileSync("/tmp/p17768/undo.txt", lines.join("\n"));
});
