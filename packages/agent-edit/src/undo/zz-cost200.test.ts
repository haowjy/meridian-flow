import { writeFileSync } from "node:fs";
import { it } from "vitest";
import * as Y from "yjs";
import * as B from "../__base/undo/forward-inverse.js";
import * as P from "../__prev/undo/forward-inverse.js";
import * as N from "./forward-inverse.js";
type Impl = typeof N;
type Part = N.InversePart;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
it("cost200", () => {
  const impls = [["main", B], ["prev", P], ["build", N]] as unknown as [string, Impl][];
  const setups = impls.map(([name, impl]) => {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = 2000;
    const p = new Y.XmlElement("paragraph"), t = new Y.XmlText();
    t.insert(0, `${Array.from({ length: 2000 }, (_, i) => `q${i}z`).join(" ")}.`);
    p.insert(0, [t]);
    doc.getXmlFragment("prosemirror").insert(0, [p]);
    const frontier = impl.captureEditFrontier(doc), updates: Uint8Array[] = [];
    const c = (u: Uint8Array) => updates.push(u);
    doc.clientID = 10000;
    doc.on("update", c);
    doc.transact(() => {
      for (let i = 0; i < 2000; i += 10) {
        const s = t.toString(), at = s.indexOf(`q${i + 5}z`);
        t.delete(at, `q${i + 5}z`.length);
        t.insert(at, `n${i + 5}z`);
      }
    });
    doc.off("update", c);
    const history: Part[] = impl.captureEditParts(doc, [{ frontier, update: Y.mergeUpdates(updates) }]).map((part, ordinal) => ({ ...part, id: ordinal + 1, editId: "e1", ordinal, kind: "write" as const, targets: [] }));
    const wf = impl.captureEditFrontier(doc), wu: Uint8Array[] = [];
    const wc = (u: Uint8Array) => wu.push(u);
    doc.clientID = 3000;
    doc.on("update", wc);
    doc.transact(() => { for (let i = 0; i < 2000; i += 10) t.insert(t.toString().indexOf(`n${i + 5}z`), "x "); });
    doc.off("update", wc);
    const w = impl.captureEditParts(doc, [{ frontier: wf, update: Y.mergeUpdates(wu) }])[0];
    history.push({ ...w, id: history.length + 1, editId: "w", ordinal: 0, kind: "write", targets: [] });
    return { name, impl, doc, parts: history.slice(0, -1), history };
  });
  const times: Record<string, number[]> = {}, samples: string[] = [];
  for (let round = 0; round < 61; round++)
    for (const s of round % 2 ? [...setups].reverse() : setups) {
      const doc = new Y.Doc({ gc: false });
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(s.doc));
      const t0 = performance.now();
      const res = s.impl.computeInverse(doc, s.history, s.parts.map((part) => ({ part, direction: "invert" as const })), { actionId: "a", allocateClient: () => 900000 + round });
      (times[s.name] ??= []).push(performance.now() - t0);
      if (round === 0) {
        for (const ed of res.edits) for (const p of ed.parts) Y.applyUpdate(doc, p.update);
        samples.push(`${s.name}: ${((doc.getXmlFragment("prosemirror").get(0) as Y.XmlElement).get(0) as Y.XmlText).toString().slice(0, 60)}`);
      }
    }
  writeFileSync("/tmp/p17663/cost200.txt", [...samples, ...Object.entries(times).map(([n, xs]) => `${n}: median ${median(xs).toFixed(1)} ms, min ${Math.min(...xs).toFixed(1)}`)].join("\n"));
}, 600000);
