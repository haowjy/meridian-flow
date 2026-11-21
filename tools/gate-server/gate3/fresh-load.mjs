// Steady-state cost of the typed rooms, and the decoded-value cache limit (the 1.17+ "budget"): load the dumped
// final snapshots of a gate 3 run into a fresh process, read them through the binding codec as a derivation does,
// and compare cache limits. node --expose-gc gate3/fresh-load.mjs <dumpDir> [cacheLimit]
import { readdirSync, readFileSync } from "node:fs";
import { LoroDoc } from "loro-crdt";
import { createNodeFromLoroObj } from "loro-prosemirror";
import { codecSchema, hookWasmMemory, mem } from "../lib/chapter.mjs";

const [dir, limit] = [process.argv[2], process.argv[3]];
await hookWasmMemory();
const files = readdirSync(dir).filter((f) => f.endsWith(".bin"));
const snaps = files.map((f) => readFileSync(`${dir}/${f}`));
const show = (label) => {
  if (process.env.MODE !== "drop-nogc") global.gc();
  const m = mem();
  console.log(JSON.stringify({ label, limit: limit ?? "default", ...m }));
};
show("before");
const load = () =>
  snaps.map((s) => {
    const d = LoroDoc.fromSnapshot(s);
    if (limit != null) d.setDecodedValueCacheLimit(Number(limit));
    return d;
  });
let docs = load();
show(
  `loaded ${docs.length} (${Math.round(snaps.reduce((a, s) => a + s.length, 0) / 1048576)} MB of snapshots)`,
);
for (const d of docs) createNodeFromLoroObj(codecSchema, d.getMap("doc"), new Map());
show("after codec read");
for (const d of docs) d.setDecodedValueCacheLimit(0);
show("after lowering the cache limit to 0");
for (const d of docs) createNodeFromLoroObj(codecSchema, d.getMap("doc"), new Map());
show("after a second codec read at limit 0");
// Unload two ways, each followed by loading and reading the set again. Linear memory never shrinks, so what shows
// whether unload gave memory back is whether the next load grows it. MODE=drop drops the references and runs GC
// without free(); the default calls free().
// MODE=drop-nogc: drop the references and let V8 collect when it wants (no forced GC), as a server would.
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    if (process.env.MODE !== "drop-nogc") global.gc();
    await new Promise((r) => setTimeout(r, 200));
  }
};
for (let round = 1; round <= 3; round++) {
  if (process.env.MODE?.startsWith("drop")) docs = null;
  else {
    for (const d of docs) d.free();
    docs = null;
  }
  await settle();
  show(
    `round ${round}: after unload (${process.env.MODE === "drop" ? "drop refs + forced gc, no free()" : process.env.MODE === "drop-nogc" ? "drop refs, no forced gc, no free()" : "free()"})`,
  );
  docs = load();
  for (const d of docs) createNodeFromLoroObj(codecSchema, d.getMap("doc"), new Map());
  show(`round ${round}: set loaded and read again`);
}
