import { writeFileSync } from "node:fs";
import { it } from "vitest";
import * as Y from "yjs";
import * as baseImpl from "../__base/undo/forward-inverse.js";
import * as buildImpl from "./forward-inverse.js";
type Impl = typeof buildImpl;
type Part = buildImpl.InversePart;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
it("cost", () => {
  const rows: string[] = [];
  for (const [paras, words] of [[50, 40], [5, 400], [1, 2000]] as const) {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = 2000;
    const frag = doc.getXmlFragment("prosemirror");
    const texts: Y.XmlText[] = [];
    for (let i = 0; i < paras; i++) {
      const p = new Y.XmlElement("paragraph"),
        t = new Y.XmlText();
      t.insert(0, `${Array.from({ length: words }, (_, j) => `w${j}`).join(" ")}.`);
      p.insert(0, [t]);
      frag.insert(i, [p]);
      texts.push(t);
    }
    const history: Part[] = [];
    let next = 10000;
    for (let n = 0; n < 300; n++) {
      const t = texts[n % paras];
      const s = t.toString();
      const target = `w${(n * 7) % words} `;
      const at = s.indexOf(target);
      if (at < 0) continue;
      const frontier = buildImpl.captureEditFrontier(doc),
        updates: Uint8Array[] = [];
      const c = (u: Uint8Array) => updates.push(u);
      doc.clientID = next++;
      doc.on("update", c);
      doc.transact(() => {
        t.delete(at, target.length - 1);
        t.insert(at, `AI${n}`);
      });
      doc.off("update", c);
      for (const [o, part] of buildImpl
        .captureEditParts(doc, [{ frontier, update: Y.mergeUpdates(updates) }])
        .entries())
        history.push({ ...part, id: history.length + 1, editId: `e${n}`, ordinal: o, kind: "write", targets: [] });
      doc.clientID = 3000;
      t.insert(at, "very ", {});
    }
    const impls = [
      ["main", baseImpl as unknown as Impl],
      ["build", buildImpl],
    ] as const;
    const classify: Record<string, number[]> = { main: [], build: [] },
      invert: Record<string, number[]> = { main: [], build: [] };
    for (const [, impl] of impls) impl.classifyEditParts(doc, history, history);
    for (let round = 0; round < 61; round++)
      for (const [name, impl] of round % 2 ? [...impls].reverse() : impls) {
        let t0 = performance.now();
        impl.classifyEditParts(doc, history, history);
        classify[name].push(performance.now() - t0);
        t0 = performance.now();
        const out = impl.computeInverse(doc, history, [{ part: history[history.length - 1], direction: "invert" }], {
          actionId: "a",
          allocateClient: () => 900000 + round,
        });
        invert[name].push(performance.now() - t0);
        if (!out.edits.length) throw new Error(`${name} inverted nothing`);
      }
    for (const name of ["main", "build"])
      rows.push(
        `${paras}x${words} words, ${history.length} parts, ${name}: classify all median ${median(classify[name]).toFixed(1)} ms (min ${Math.min(...classify[name]).toFixed(1)}, max ${Math.max(...classify[name]).toFixed(1)}); one Undo median ${median(invert[name]).toFixed(1)} ms (min ${Math.min(...invert[name]).toFixed(1)}, max ${Math.max(...invert[name]).toFixed(1)})`,
      );
  }
  writeFileSync("/tmp/p17663/cost.txt", rows.join("\n"));
}, 600000);
