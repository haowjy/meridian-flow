// Which part of a room load leaks when the loop never yields: 120 loads, 20 open, the oldest freed with free().
// node --expose-gc gate3/handles.mjs <dumpDir> <load|read|fork|edit|import|export joined by +>   (YIELD=1 to yield per load)
import { readdirSync, readFileSync } from "node:fs";
import { LoroDoc } from "loro-crdt";
import { createNodeFromLoroObj } from "loro-prosemirror";
import { codecSchema, configure, hookWasmMemory, keystroke, mem, rng } from "../lib/chapter.mjs";

await hookWasmMemory();
const dir = process.argv[2],
  V = process.argv[3];
const snaps = readdirSync(dir)
  .filter((f) => f.endsWith(".bin"))
  .map((f) => readFileSync(`${dir}/${f}`));
const r = rng(3);
const open = [];
const w = () => mem().wasm;
const out = [];
for (let k = 0; k < 120; k++) {
  const doc = LoroDoc.fromSnapshot(snaps[k % snaps.length]);
  if (V.includes("read")) createNodeFromLoroObj(codecSchema, doc.getMap("doc"), new Map());
  if (V.includes("fork")) {
    const c = doc.fork();
    c.free();
  }
  if (V.includes("edit")) {
    const c = doc.fork();
    configure(c);
    c.setPeerId(String(5e6 + k));
    const from = c.oplogVersion();
    const cur = { block: 5, offset: 0 };
    for (let i = 0; i < 20; i++) keystroke(c, cur, r);
    const u = c.export({ mode: "update", from });
    c.free();
    if (V.includes("import")) doc.import(u);
  }
  if (V.includes("export")) doc.export({ mode: "snapshot" });
  open.push(doc);
  if (open.length > 20) open.shift().free();
  if (process.env.YIELD) await new Promise((res) => setTimeout(res, 1));
  if (k === 39 || k === 119) out.push(w());
}
console.log(
  V.padEnd(24),
  "wasm at 40 loads",
  out[0],
  "at 120",
  out[1],
  "MB/load",
  ((out[1] - out[0]) / 80).toFixed(2),
);
