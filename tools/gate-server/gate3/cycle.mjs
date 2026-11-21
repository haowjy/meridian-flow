// Room churn: 200 rooms cycled through a window of 50 open ones. Each load reads the room through the binding codec
// (a join and its derivation), imports a few keystrokes, exports a snapshot, and the oldest open room is unloaded
// with free(). Does the WASM high-water mark stay at the working set, or grow with rooms cycled through?
// node --expose-gc gate3/cycle.mjs <dumpDir> <passes> [cacheLimit]
import { readdirSync, readFileSync } from "node:fs";
import { LoroDoc } from "loro-crdt";
import { createNodeFromLoroObj } from "loro-prosemirror";
import { codecSchema, configure, hookWasmMemory, keystroke, mem, rng } from "../lib/chapter.mjs";

const [dir, passes, limit] = [process.argv[2], Number(process.argv[3] ?? 5), process.argv[4]];
await hookWasmMemory();
const files = readdirSync(dir).filter((f) => f.endsWith(".bin"));
const snaps = [...files, ...files].map((f) => readFileSync(`${dir}/${f}`)); // 200 rooms (each dump opened as two)
const OPEN = 50,
  r = rng(3);
const open = [];
const show = (label) => {
  console.log(JSON.stringify({ label, limit: limit ?? "default", open: open.length, ...mem() }));
};
show("start");
let loads = 0;
for (let p = 0; p < passes; p++) {
  for (let k = 0; k < snaps.length; k++) {
    const doc = LoroDoc.fromSnapshot(snaps[k]);
    if (limit != null) doc.setDecodedValueCacheLimit(Number(limit));
    createNodeFromLoroObj(codecSchema, doc.getMap("doc"), new Map());
    // a writer's few keystrokes arrive from a client doc, then the debounced snapshot
    const client = doc.fork();
    configure(client);
    client.setPeerId(String(5_000_000 + loads));
    const from = client.oplogVersion();
    const cur = { block: 5, offset: 0 };
    for (let i = 0; i < 20; i++) keystroke(client, cur, r);
    doc.import(client.export({ mode: "update", from }));
    client.free();
    doc.export({ mode: "snapshot" });
    open.push(doc);
    loads++;
    if (open.length > OPEN) open.shift().free();
    // Yield as a server does between messages. free() releases a doc only once the JS handles its readers took
    // (LoroMap, LoroText) are collected, and their finalizers run only when the event loop turns: a loop that
    // never yields grew 3.3 MB per load to 3.3 GB over 1000 loads.
    await new Promise((res) => setTimeout(res, 1));
    if (loads % 50 === 0) show(`pass ${p + 1}, ${loads} loads`);
  }
}
while (open.length) open.shift().free();
show("all unloaded");
