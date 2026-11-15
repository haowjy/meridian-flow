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
  const p = new Y.XmlElement("paragraph"),
    t = new Y.XmlText();
  t.insert(0, body);
  p.insert(0, [t]);
  doc.getXmlFragment("prosemirror").insert(0, [p]);
  const v = { doc, history: [] as Part[], next: 10000 };
  const text = () =>
    (v.doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
  const str = () => text().toString();
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
    v.doc.transact(() => fn(text()));
    v.doc.off("update", collect);
    const id = (v.history.at(-1)?.id ?? 0) + 1;
    const parts = impl
      .captureEditParts(v.doc, [{ frontier, update: Y.mergeUpdates(updates) }])
      .map((part, ordinal) => ({
        ...part,
        id: id + ordinal,
        editId: `e${id}`,
        ordinal,
        kind: "write" as const,
        targets: [],
      }));
    v.history.push(...parts);
    return parts;
  };
  const inverse = (parts: Part[], direction: "invert" | "reapply", keep = false) => {
    const cold = new Y.Doc({ gc: false });
    Y.applyUpdate(cold, Y.encodeStateAsUpdate(v.doc));
    v.doc.destroy();
    v.doc = cold;
    const result = impl.computeInverse(
      v.doc,
      v.history,
      parts.map((part) => ({ part, direction })),
      {
        actionId: `a${v.history.length}`,
        allocateClient: () => v.next++,
        keepLaterWords: keep,
      },
    );
    for (const edit of result.edits) {
      const editId = `e${(v.history.at(-1)?.id ?? 0) + 1}`;
      for (const [ordinal, part] of edit.parts.entries()) {
        Y.applyUpdate(v.doc, part.update);
        v.history.push({
          ...part,
          id: (v.history.at(-1)?.id ?? 0) + 1,
          editId,
          ordinal,
          kind: direction === "invert" ? "undo" : "redo",
          actionId: result.actionId,
        });
      }
    }
    return `${result.edits.length ? "did" : `skipped(${result.skipped.map((s) => s.reasons.join("/") || s.state)})`}: ${str()}`;
  };
  return { v, text, str, raw, write, inverse };
}
const swap = (from: string, to: string) => (t: Y.XmlText) => {
  const at = t.toString().indexOf(from);
  t.delete(at, from.length);
  t.insert(at, to);
};
const out: string[] = [];
for (const [name, impl] of [
  ["main", baseImpl as unknown as Impl],
  ["proto", protoImpl],
] as const) {
  it(`${name}: an earlier AI part deleted the suffix`, () => {
    const h = harness(impl, "One smallish cat.");
    const p0 = h.write((t) => t.delete(9, 3));
    const p1 = h.write(swap("small", "big"));
    h.raw(2002, (t) => t.insert(4, "very "));
    out.push(
      `${name} owned-suffix: ${h.str()} | undo p1 ${h.inverse(p1, "invert")} | undo p0 ${h.inverse(p0, "invert")} | redo p0 ${h.inverse(p0, "reapply")} | redo p1 ${h.inverse(p1, "reapply")}`,
    );
  });
  it(`${name}: the writer deleted the suffix, then takes it back in the browser`, () => {
    const h = harness(impl, "One smallish cat.");
    const um = new Y.UndoManager(h.text(), { trackedOrigins: new Set(["w"]) });
    h.v.doc.clientID = 2000;
    h.v.doc.transact(() => h.text().delete(9, 3), "w");
    const p1 = h.write(swap("small", "big"));
    h.raw(2002, (t) => t.insert(4, "very "));
    // the browser keeps its own doc and undo stack; apply the server inverse to it as a remote update
    const before = Y.encodeStateVector(h.v.doc);
    const live = h.v.doc;
    const cold = new Y.Doc({ gc: false });
    Y.applyUpdate(cold, Y.encodeStateAsUpdate(live));
    const result = impl.computeInverse(
      cold,
      h.v.history,
      p1.map((part) => ({ part, direction: "invert" as const })),
      { actionId: "a", allocateClient: () => h.v.next++ },
    );
    for (const edit of result.edits)
      for (const part of edit.parts) Y.applyUpdate(live, part.update, "remote");
    void before;
    const afterUndo = h.str();
    live.clientID = 2000;
    um.undo();
    out.push(`${name} writer-suffix: undo AI -> ${afterUndo} | writer Ctrl+Z -> ${h.str()}`);
  });
  it(`${name}: old typo tombstone inside the word, Un-Apply and card`, () => {
    for (const keep of [false, true]) {
      const h = harness(impl, "One small cat.");
      h.raw(2001, (t) => t.insert(6, "k"));
      h.raw(2001, (t) => t.delete(6, 1));
      const p1 = h.write(swap("small", "big"));
      h.raw(2002, (t) => t.insert(4, "very "));
      out.push(
        `${name} typo-inside keep=${keep}: ${h.inverse(p1, "invert", keep)} | redo ${h.inverse(p1, "reapply", keep)} | undo ${h.inverse(p1, "invert", keep)}`,
      );
    }
  });
  it(`${name}: writer deleted the AI word, or replaced it`, () => {
    let h = harness(impl, "One small cat.");
    let p1 = h.write(swap("small", "big"));
    h.raw(2002, (t) => t.insert(4, "very "));
    h.raw(2002, (t) => t.delete(9, 3));
    out.push(
      `${name} typed-before-then-deleted-AI-word: ${h.str()} | undo ${h.inverse(p1, "invert")} | redo ${h.inverse(p1, "reapply")}`,
    );
    h = harness(impl, "One small cat.");
    p1 = h.write(swap("small", "big"));
    h.raw(2002, swap("big", "large"));
    out.push(`${name} writer-replaced: ${h.str()} | undo ${h.inverse(p1, "invert")}`);
    h = harness(impl, "One small cat.");
    p1 = h.write(swap("small", "big"));
    h.raw(2002, (t) => t.insert(5, "XX"));
    h.raw(2003, (t) => t.insert(4, "very "));
    out.push(
      `${name} typing-inside-AI-word: ${h.str()} | undo ${h.inverse(p1, "invert")} | redo ${h.inverse(p1, "reapply")} | undo ${h.inverse(p1, "invert")}`,
    );
  });
  it(`${name}: a peer's concurrent typing at the seam merges with the inverse`, () => {
    const h = harness(impl, "One small cat.");
    const p1 = h.write(swap("small", "big"));
    h.raw(2002, (t) => t.insert(4, "very "));
    const peer = new Y.Doc({ gc: false });
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(h.v.doc));
    peer.clientID = 3000;
    const pt = (peer.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText;
    pt.insert(9, "really ");
    const offline = Y.encodeStateAsUpdate(peer);
    h.inverse(p1, "invert");
    Y.applyUpdate(h.v.doc, offline);
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(h.v.doc));
    out.push(`${name} concurrent-peer: server ${h.str()} | peer ${pt.toString()}`);
  });
}
it("zz", () => writeFileSync("/tmp/p17524-hazards.txt", out.join("\n")));
