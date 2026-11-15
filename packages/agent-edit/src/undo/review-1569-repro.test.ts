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

describe("scratch p17506", () => {
  it("1 base repro + cycles", () => {
    const v = base(["One small cat."]);
    const e = write(v, [(v) => swap(v, "small", "big")]);
    typeAs(v, (v) => text(v).insert(at(v, "big"), "very "));
    rec("1 start", v);
    for (const d of ["invert", "reapply", "invert", "reapply", "invert"] as const) {
      const n = inverse(v, e, d);
      rec(`1 ${d} n=${n}`, v);
    }
  });
  it("2 chained AI edits, writer types before the restored AI word", () => {
    const v = base(["One small cat."]);
    const e1 = write(v, [(v) => swap(v, "small", "big")]);
    const e2 = write(v, [(v) => swap(v, "big", "huge")]);
    rec(`2 inv e2 n=${inverse(v, e2, "invert")}`, v);
    typeAs(v, (v) => text(v).insert(at(v, "big"), "very "));
    rec("2 typed", v);
    rec(`2 inv e1 n=${inverse(v, e1, "invert")}`, v);
  });
  it("3 writer types after", () => {
    const v = base(["One small cat."]);
    const e = write(v, [(v) => swap(v, "small", "big")]);
    typeAs(v, (v) => text(v).insert(at(v, "big") + 3, " very"));
    rec("3 typed", v);
    rec(`3 inv n=${inverse(v, e, "invert")}`, v);
  });
  it("4 bold word", () => {
    const v = base([""]);
    text(v).insert(0, "One ");
    text(v).insert(4, "small", { bold: true });
    text(v).insert(9, " cat.", { bold: null });
    const e = write(v, [
      (v) => {
        text(v).delete(4, 5);
        text(v).insert(4, "big");
      },
    ]);
    rec("4 edited", v);
    typeAs(v, (v) => text(v).insert(at(v, "big"), "very "));
    rec("4 typed", v);
    rec(`4 inv n=${inverse(v, e, "invert")}`, v);
    rec(`4 reapply n=${inverse(v, e, "reapply")}`, v);
    rec(`4 inv n=${inverse(v, e, "invert")}`, v);
  });
  it("4b bold word, no typing", () => {
    const v = base([""]);
    text(v).insert(0, "One ");
    text(v).insert(4, "small", { bold: true });
    text(v).insert(9, " cat.", { bold: null });
    const e = write(v, [
      (v) => {
        text(v).delete(4, 5);
        text(v).insert(4, "big");
      },
    ]);
    rec(`4b inv n=${inverse(v, e, "invert")}`, v);
  });
  it("4c AI keeps bold on replacement", () => {
    const v = base([""]);
    text(v).insert(0, "One ");
    text(v).insert(4, "small", { bold: true });
    text(v).insert(9, " cat.", { bold: null });
    const e = write(v, [
      (v) => {
        text(v).delete(4, 5);
        text(v).insert(4, "big", { bold: true });
      },
    ]);
    rec("4c edited", v);
    typeAs(v, (v) => text(v).insert(at(v, "big"), "very ", { bold: null }));
    rec("4c typed", v);
    rec(`4c inv n=${inverse(v, e, "invert")}`, v);
    rec(`4c reapply n=${inverse(v, e, "reapply")}`, v);
  });
  it("4d plain word replaced by bold", () => {
    const v = base(["One small cat."]);
    const e = write(v, [
      (v) => {
        text(v).delete(4, 5);
        text(v).insert(4, "big", { bold: true });
      },
    ]);
    typeAs(v, (v) => text(v).insert(at(v, "big"), "very ", {}));
    rec("4d typed", v);
    rec(`4d inv n=${inverse(v, e, "invert")}`, v);
  });
  it("5 partial run: AI deletes 'small cat', inserts 'dog'; writer types before", () => {
    const v = base(["One small cat."]);
    const e = write(v, [(v) => swap(v, "small cat", "dog")]);
    typeAs(v, (v) => text(v).insert(at(v, "dog"), "a "));
    rec("5 typed", v);
    rec(`5 inv n=${inverse(v, e, "invert")}`, v);
  });
  it("6 replacement with two AI inserts at seam (two parts)", () => {
    const v = base(["One small cat."]);
    const e = write(v, [
      (v) => swap(v, "small", "big"),
      (v) => text(v).insert(at(v, "big"), "red "),
    ]);
    typeAs(v, (v) => text(v).insert(at(v, "red"), "very "));
    rec("6 typed", v);
    rec(`6 inv both n=${inverse(v, e, "invert")}`, v);
  });
  it("6b invert only the second part then first", () => {
    const v = base(["One small cat."]);
    const e = write(v, [
      (v) => swap(v, "small", "big"),
      (v) => text(v).insert(at(v, "big"), "red "),
    ]);
    typeAs(v, (v) => text(v).insert(at(v, "red"), "very "));
    rec(`6b inv p2 n=${inverse(v, [e[1]], "invert")}`, v);
    rec(`6b inv p1 n=${inverse(v, [e[0]], "invert")}`, v);
  });
  it("7 one edit: replace then replace again in same part", () => {
    const v = base(["One small cat."]);
    const e = write(v, [
      (v) => {
        swap(v, "small", "big");
        swap(v, "big", "huge");
      },
    ]);
    typeAs(v, (v) => text(v).insert(at(v, "huge"), "very "));
    rec("7 typed", v);
    rec(`7 inv n=${inverse(v, e, "invert")}`, v);
  });
  it("8 un-apply after card undo then redo then undo with typing in between", () => {
    const v = base(["One small cat."]);
    const e = write(v, [(v) => swap(v, "small", "big")]);
    rec(`8 inv n=${inverse(v, e, "invert")}`, v);
    typeAs(v, (v) => text(v).insert(at(v, "small"), "very "));
    rec("8 typed", v);
    rec(`8 reapply n=${inverse(v, e, "reapply")}`, v);
    typeAs(v, (v) => text(v).insert(at(v, "big"), "so "));
    rec("8 typed2", v);
    rec(`8 inv n=${inverse(v, e, "invert")}`, v);
    // invert the undo entry itself (revert)
  });
  it("9 writer types at both sides", () => {
    const v = base(["One small cat."]);
    const e = write(v, [(v) => swap(v, "small", "big")]);
    typeAs(v, (v) => text(v).insert(at(v, "big"), "very "));
    typeAs(v, (v) => text(v).insert(at(v, "big") + 3, "gest"));
    rec("9 typed", v);
    rec(`9 inv n=${inverse(v, e, "invert")}`, v);
  });
  it("10 live replay of history equals cold", () => {
    const v = base(["One small cat."]);
    const seed = Y.encodeStateAsUpdate(v.doc);
    const e = write(v, [(v) => swap(v, "small", "big")]);
    typeAs(v, (v) => text(v).insert(at(v, "big"), "very "));
    inverse(v, e, "invert");
    inverse(v, e, "reapply");
    inverse(v, e, "invert");
    const live = new Y.Doc({ gc: false });
    Y.applyUpdate(live, seed);
    for (const p of v.history) Y.applyUpdate(live, p.update);
    rec("10 cold", v);
    rec("10 live", { doc: live, history: [], nextClient: 0 });
  });
  it("zz print", () => {
    writeFileSync("/tmp/p17506-out.txt", log.join("\n"));
  });
});
const dump = (v: View) => {
  const out: string[] = [];
  for (let it = text(v)._start; it; it = it.right)
    out.push(
      `${it.deleted ? "~" : ""}${it.id.client}:${it.id.clock}${it.content instanceof Y.ContentString ? JSON.stringify(it.content.str) : it.content.constructor.name} o=${it.origin ? `${it.origin.client}:${it.origin.clock}` : "-"} r=${it.redone ? `${it.redone.client}:${it.redone.clock}` : "-"}`,
    );
  return out.join("\n  ");
};
describe("scratch dump", () => {
  it("2 dump", () => {
    (globalThis as any).__dbg = [];
    const v = base(["One small cat."]);
    const e1 = write(v, [(v) => swap(v, "small", "big")]);
    const e2 = write(v, [(v) => swap(v, "big", "huge")]);
    inverse(v, e2, "invert");
    const a = `after inv e2\n  ${dump(v)}`;
    typeAs(v, (v) => text(v).insert(at(v, "big"), "very "));
    const b = `typed\n  ${dump(v)}`;
    inverse(v, e1, "invert");
    writeFileSync(
      "/tmp/p17506-dump.txt",
      [
        a,
        b,
        `after inv e1\n  ${dump(v)}`,
        JSON.stringify(v.history.at(-1)?.update?.length),
        ...(globalThis as any).__dbg,
      ].join("\n"),
    );
  });
});
function inverseK(v: View, parts: InversePart[], direction: "invert" | "reapply", keep: boolean) {
  cold(v);
  const result = computeInverse(
    v.doc,
    v.history,
    parts.map((part) => ({ part, direction })),
    {
      actionId: `a${v.history.length}`,
      allocateClient: () => v.nextClient++,
      keepLaterWords: keep,
    } as never,
  );
  for (const edit of result.edits)
    for (const [ordinal, p] of edit.parts.entries()) {
      Y.applyUpdate(v.doc, p.update);
      v.history.push({
        ...p,
        id: (v.history.at(-1)?.id ?? 0) + 1,
        editId: `x${v.history.length}`,
        ordinal,
        kind: direction === "invert" ? "undo" : "redo",
        actionId: result.actionId,
      });
    }
  return `edits=${result.edits.length} skipped=${JSON.stringify(result.skipped.map((s) => s.reasons ?? s.state))}`;
}
const log2: string[] = [];
describe("scratch more", () => {
  for (const keep of [false, true]) {
    it(`12 chained keep=${keep}`, () => {
      const v = base(["One small cat."]);
      const e1 = write(v, [(v) => swap(v, "small", "big")]);
      const e2 = write(v, [(v) => swap(v, "big", "huge")]);
      log2.push(`12 keep=${keep} inv e2 ${inverseK(v, e2, "invert", keep)} ${content(v)}`);
      typeAs(v, (v) => text(v).insert(at(v, "big"), "very "));
      log2.push(
        `12 keep=${keep} inv e1 ${inverseK(v, e1, "invert", keep)} ${content(v)} states=${states(v, e1)}`,
      );
      log2.push(`12 keep=${keep} reapply e1 ${inverseK(v, e1, "reapply", keep)} ${content(v)}`);
    });
    it(`12b chained, typing after keep=${keep}`, () => {
      const v = base(["One small cat."]);
      const e1 = write(v, [(v) => swap(v, "small", "big")]);
      const e2 = write(v, [(v) => swap(v, "big", "huge")]);
      inverseK(v, e2, "invert", keep);
      typeAs(v, (v) => text(v).insert(at(v, "big") + 3, " very"));
      log2.push(`12b keep=${keep} inv e1 ${inverseK(v, e1, "invert", keep)} ${content(v)}`);
    });
    it(`1k base repro keep=${keep}`, () => {
      const v = base(["One small cat."]);
      const e = write(v, [(v) => swap(v, "small", "big")]);
      typeAs(v, (v) => text(v).insert(at(v, "big"), "very "));
      log2.push(`1k keep=${keep} ${inverseK(v, e, "invert", keep)} ${content(v)}`);
    });
  }
  it("13 chained no typing", () => {
    const v = base(["One small cat."]);
    const e1 = write(v, [(v) => swap(v, "small", "big")]);
    const e2 = write(v, [(v) => swap(v, "big", "huge")]);
    inverse(v, e2, "invert");
    inverse(v, e1, "invert");
    log2.push(`13 ${content(v)}`);
  });
  it("11 mid-run format", () => {
    const v = base([""]);
    text(v).insert(0, "One small ");
    text(v).insert(10, "red", { bold: true });
    text(v).insert(13, " cat.", { bold: null });
    const e = write(v, [
      (v) => {
        text(v).delete(4, 9);
        text(v).insert(4, "big");
      },
    ]);
    typeAs(v, (v) => text(v).insert(at(v, "big"), "very "));
    log2.push(`11 typed ${delta(v)}`);
    log2.push(`11 inv ${inverse(v, e, "invert")} ${delta(v)}`);
    log2.push(`11 reapply ${inverse(v, e, "reapply")} ${delta(v)}`);
    log2.push(`11 inv ${inverse(v, e, "invert")} ${delta(v)}`);
  });
  it("14 e2 undo, e1 undo, e1 redo, e2 redo with typing", () => {
    const v = base(["One small cat."]);
    const e1 = write(v, [(v) => swap(v, "small", "big")]);
    typeAs(v, (v) => text(v).insert(at(v, "big"), "very "));
    const e2 = write(v, [(v) => swap(v, "big", "huge")]);
    for (const [p, d] of [
      [e2, "invert"],
      [e1, "invert"],
      [e1, "reapply"],
      [e2, "reapply"],
    ] as const)
      log2.push(`14 ${d} ${inverse(v, p, d)} ${content(v)}`);
  });
  it("zz2", () => writeFileSync("/tmp/p17506-out2.txt", log2.join("\n")));
});
const log3: string[] = [];
describe("scratch keep", () => {
  it("14k", () => {
    const v = base(["One small cat."]);
    const e1 = write(v, [(v) => swap(v, "small", "big")]);
    typeAs(v, (v) => text(v).insert(at(v, "big"), "very "));
    const e2 = write(v, [(v) => swap(v, "big", "huge")]);
    log3.push(`14k e2 ${inverseK(v, e2, "invert", true)} ${content(v)}`);
    log3.push(`14k e1 ${inverseK(v, e1, "invert", true)} ${content(v)}`);
  });
  it("7k", () => {
    const v = base(["One small cat."]);
    const e = write(v, [
      (v) => {
        swap(v, "small", "big");
        swap(v, "big", "huge");
      },
    ]);
    typeAs(v, (v) => text(v).insert(at(v, "huge"), "very "));
    log3.push(`7k ${inverseK(v, e, "invert", true)} ${content(v)}`);
  });
  it("zz3", () => writeFileSync("/tmp/p17506-out3.txt", log3.join("\n")));
});
