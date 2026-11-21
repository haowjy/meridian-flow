// Gate 3 server: 50 Live rooms + 50 fork rooms in one process, debounced snapshot export (2 s / 10 s),
// memory sampled every 10 s, then unload (free) and reload to see whether memory comes back.
// node --expose-gc gate3/run.mjs <minutes> <out.jsonl>
import { fork as spawnChild } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { LoroDoc } from "loro-crdt";
import { createNodeFromLoroObj } from "loro-prosemirror";
import { codecSchema, configure, hookWasmMemory, mem } from "../lib/chapter.mjs";

const MINUTES = Number(process.argv[2] ?? 60);
const OUT = process.argv[3] ?? "gate3-run.jsonl";
const CACHE_LIMIT = process.env.CACHE_LIMIT; // optional setDecodedValueCacheLimit for every room
await hookWasmMemory();
writeFileSync(OUT, "");
const t0 = Date.now();
const log = (o) => {
  const line = JSON.stringify({ s: Math.round((Date.now() - t0) / 1000), ...o });
  appendFileSync(OUT, `${line}\n`);
};
const sample = (phase, extra = {}) => {
  const m = mem();
  log({ phase, ...m, ...extra });
  return m;
};

let serverPeer = 1_000_000n;
const rooms = new Map(); // key -> { doc, firstAt, timer, kind, i }
const stats = { imports: 0, importMs: [], saves: 0, saveMs: [], saveBytes: [], deriveMs: [] };
const NO_DERIVE = process.env.NO_DERIVE === "1";
function openRoom(key, snap) {
  const doc = LoroDoc.fromSnapshot(snap);
  doc.setPeerId(String(serverPeer++));
  configure(doc);
  if (CACHE_LIMIT != null) doc.setDecodedValueCacheLimit(Number(CACHE_LIMIT));
  rooms.set(key, { doc, firstAt: 0, timer: null });
}
function save(key) {
  const room = rooms.get(key);
  if (!room) return;
  clearTimeout(room.timer);
  room.timer = null;
  room.firstAt = 0;
  const t = performance.now();
  const bytes = room.doc.export({ mode: "snapshot" });
  stats.saveMs.push(performance.now() - t);
  stats.saves++;
  stats.saveBytes.push(bytes.length);
  // A Live save is followed by its derivation, which reads the room through the binding codec (design §4).
  if (key.startsWith("live:") && !NO_DERIVE) {
    const d = performance.now();
    createNodeFromLoroObj(codecSchema, room.doc.getMap("doc"), new Map());
    stats.deriveMs.push(performance.now() - d);
  }
  return bytes; // a DB write would go here; gate 4 measures that
}
function schedule(key) {
  const room = rooms.get(key);
  const now = Date.now();
  if (!room.firstAt) room.firstAt = now;
  clearTimeout(room.timer);
  room.timer = setTimeout(
    () => save(key),
    Math.max(0, Math.min(now + 2000, room.firstAt + 10000) - now),
  );
}
function write(key, updates) {
  const room = rooms.get(key);
  const t = performance.now();
  for (const u of updates) room.doc.import(u);
  stats.importMs.push((performance.now() - t) / updates.length);
  stats.imports += updates.length;
  schedule(key);
}

const child = spawnChild(new URL("./typist.mjs", import.meta.url), {
  serialization: "advanced",
  env: { ...process.env },
});
log({ phase: "start", childPid: child.pid, serverPid: process.pid });
console.log(`server pid ${process.pid}, typist pid ${child.pid}`);
let keys = 0;
const seeded = new Promise((res) =>
  child.on("message", (m) => {
    if (m.t === "seed") {
      openRoom(`live:${m.room}`, m.live);
      openRoom(`fork:${m.room}`, m.fork);
    } else if (m.t === "seeded") res();
    else if (m.t === "upd") {
      const key = `${m.kind}:${m.room}`;
      write(key, m.updates);
      if (m.kind === "live") write(`fork:${m.room}`, m.updates); // forward Live into the loaded fork (design §4)
    } else if (m.t === "keys" || m.t === "stopped") keys = m.keys;
  }),
);
await seeded;
global.gc();
sample("seeded", { rooms: rooms.size });

const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))] * 1000) / 1000;
};
const interval = setInterval(() => {
  const m = sample("typing", {
    keys,
    imports: stats.imports,
    saves: stats.saves,
    importP50: pct(stats.importMs, 0.5),
    importP99: pct(stats.importMs, 0.99),
    saveP50: pct(stats.saveMs, 0.5),
    saveP99: pct(stats.saveMs, 0.99),
    deriveP50: pct(stats.deriveMs, 0.5),
    snapKB: Math.round(stats.saveBytes.at(-1) / 1024),
  });
  stats.importMs = [];
  stats.saveMs = [];
  stats.deriveMs = [];
  if ((Date.now() - t0) % 60000 < 10000)
    console.log(
      `${Math.round((Date.now() - t0) / 60000)} min rss ${m.rss} heap ${m.heapUsed} wasm ${m.wasm} keys ${keys}`,
    );
}, 10000);
await new Promise((r) => setTimeout(r, MINUTES * 60000));
clearInterval(interval);

child.send({ t: "stop" });
await new Promise((r) => child.on("exit", r));
const finals = new Map();
for (const key of [...rooms.keys()]) finals.set(key, save(key));
if (process.env.DUMP) {
  mkdirSync(process.env.DUMP, { recursive: true });
  for (const [key, bytes] of finals)
    writeFileSync(`${process.env.DUMP}/${key.replace(":", "-")}.bin`, bytes);
}
global.gc();
sample("stopped", {
  keys,
  imports: stats.imports,
  saves: stats.saves,
  finalSnapKB: Math.round([...finals.values()].reduce((a, b) => a + b.length, 0) / 1024),
});

const settle = async (phase, n = 5) => {
  for (let i = 0; i < n; i++) {
    global.gc();
    await new Promise((r) => setTimeout(r, 2000));
    sample(phase);
  }
};
// Unload half, then all: drop the docs and free them.
const unload = (filter) => {
  for (const [key, room] of [...rooms])
    if (filter(key)) {
      room.doc.free();
      rooms.delete(key);
    }
};
unload((k) => Number(k.split(":")[1]) < 25);
await settle("unloaded-half");
unload(() => true);
await settle("unloaded-all");
// Reload every room from its final snapshot, then read each (as a derivation would), then unload again.
for (const [key, snap] of finals) openRoom(key, snap);
await settle("reloaded", 2);
for (const { doc } of rooms.values()) doc.toJSON();
await settle("reloaded-read", 2);
for (const [_key, room] of rooms)
  createNodeFromLoroObj(codecSchema, room.doc.getMap("doc"), new Map());
await settle("reloaded-walked", 2);
unload(() => true);
await settle("unloaded-again", 3);
console.log("done");
process.exit(0);
