// Gate 4 harness: 10 tabs typing into one document on the gate 4 server, an AI turn and a press, a deploy
// overlap (two server processes on one room, both saving), two kill -9s, reconnect and resend.
// node gate4/run.mjs <adminDatabaseUrl> <outDir>
import { fork } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { LoroDoc } from "loro-crdt";
import postgres from "postgres";
import { buildChapter, rng } from "../lib/chapter.mjs";
import { Tab } from "./tab.mjs";

const ADMIN = process.argv[2] ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const OUT = process.argv[3] ?? "/tmp/p18917/g4";
const DB = `gate_${process.env.MERIDIAN_SPAWN_ID ?? "p18917"}`;
const DB_URL = ADMIN.replace(/\/[^/]*$/, `/${DB}`);
const ROOM = "live:chapter-1",
  SOLO_ROOM = "live:chapter-2"; // SOLO_ROOM: one writer alone
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/stores`, { recursive: true });
const LOG = `${OUT}/server.jsonl`;
writeFileSync(LOG, "");
const report = [];
const say = (...a) => {
  const s = a.join(" ");
  console.log(s);
  report.push(s);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

// Database: our own, dropped at the end.
const admin = postgres(ADMIN, { max: 1, onnotice: () => {} });
await admin.unsafe(`drop database if exists ${DB}`);
await admin.unsafe(`create database ${DB}`);
const sql = postgres(DB_URL, { max: 2, onnotice: () => {} });
await sql`create table document_snapshots (room_key text primary key, snapshot bytea not null, frontiers jsonb not null, saved_at timestamptz not null)`;
for (const [room, n] of [
  [ROOM, 7],
  [SOLO_ROOM, 8],
]) {
  const seed = buildChapter(n, "1");
  await sql`insert into document_snapshots values (${room}, ${seed.export({ mode: "snapshot" })}, ${sql.json(seed.frontiers())}, now())`;
  seed.free();
}
const dbDoc = async (room = ROOM) => {
  const [row] = await sql`select snapshot from document_snapshots where room_key = ${room}`;
  return LoroDoc.fromSnapshot(row.snapshot);
};

// Servers: child processes we started, killed only by their PID.
const servers = [];
process.on("exit", () => {
  for (const s of servers)
    if (s.child.exitCode === null && s.child.signalCode === null) process.kill(s.pid, "SIGKILL");
});
process.on("uncaughtException", (e) => {
  console.error(e);
  process.exit(1);
});
function startServer(name, port) {
  return new Promise((res) => {
    const child = fork(new URL("./server.mjs", import.meta.url), [String(port), DB_URL, name], {
      env: { ...process.env, GATE4_LOG: LOG },
      stdio: "inherit",
    });
    servers.push({ name, pid: child.pid, child });
    child.on("message", (m) => m.t === "listening" && res(child));
  });
}
const call = async (port, path) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
};
const serverLog = () =>
  readFileSync(LOG, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const P1 = 47100 + Math.floor(Math.random() * 400),
  P2 = P1 + 1;
const s1 = await startServer("S1", P1);
say(`${at()} S1 pid ${s1.pid} on ${P1}`);

const tabs = [];
const closedSessions = []; // { peer, acked } of tab sessions that ended
for (let i = 0; i < 10; i++)
  tabs.push(
    new Tab({
      id: i,
      url: `ws://127.0.0.1:${P1}`,
      room: ROOM,
      storePath: `${OUT}/stores/tab${i}.bin`,
      rng: rng(100 + i),
    }),
  );
const solo = new Tab({
  id: 10,
  url: `ws://127.0.0.1:${P1}`,
  room: SOLO_ROOM,
  storePath: `${OUT}/stores/solo.bin`,
  rng: rng(110),
});

// Typing: ~5 keystrokes/s per tab (Poisson per 50 ms tick), each tab pausing now and then; batches every 50 ms.
let typing = true;
const r = rng(9);
const pauses = tabs.map(() => 0);
const typer = setInterval(() => {
  if (!typing) return;
  const now = Date.now();
  for (const [i, tab] of tabs.entries()) {
    if (now < pauses[i]) {
      tab.flush();
      continue;
    }
    if (r() < 0.004) pauses[i] = now + 1000 + r() * 4000;
    let n = 0,
      p = Math.exp(-0.25),
      s = p;
    const u = r();
    while (u > s) {
      n++;
      p *= 0.25 / n;
      s += p;
    }
    tab.type(n);
    tab.flush();
  }
  if (!solo.closed) {
    let n = 0,
      p = Math.exp(-0.25),
      s = p;
    const u = r();
    while (u > s) {
      n++;
      p *= 0.25 / n;
      s += p;
    }
    solo.type(n);
    solo.flush();
  }
}, 50);

async function quiesce() {
  typing = false;
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (tabs.every((t) => t.joined && t.inflight.size === 0 && t.pending.length === 0)) break;
  }
  await sleep(500);
}
async function converged(port, label) {
  const st = await call(port, `/state?room=${encodeURIComponent(ROOM)}`);
  const want = JSON.stringify(st.json);
  const equal = tabs.filter((t) => JSON.stringify(t.doc.toJSON()) === want).length;
  say(
    `${at()} ${label}: ${equal}/${tabs.length} tabs equal the server's document; server ops ${Object.values(st.vv).reduce((a, b) => a + b, 0)}`,
  );
  return equal === tabs.length;
}
// Loss accounting against what the database holds right now.
async function lossCheck(_label) {
  const d = await dbDoc();
  const vv = d.oplogVersion();
  const sessions = [
    ...tabs.map((t) => ({
      peer: t.peer,
      acked: t.acked,
      typed: t.doc.oplogVersion().get(t.peer) ?? 0,
    })),
    ...closedSessions,
  ];
  let ackedMissing = 0,
    typedMissing = 0;
  for (const s of sessions) {
    const have = vv.get(s.peer) ?? 0;
    ackedMissing += Math.max(0, s.acked - have);
    typedMissing += Math.max(0, (s.typed ?? s.acked) - have);
  }
  const text = JSON.stringify(d.toJSON());
  d.free();
  return { ackedMissing, typedMissing, text };
}
const lastSave = (room = ROOM) =>
  serverLog()
    .filter((e) => e.ev === "save" && e.room === room)
    .at(-1);

// 1. Steady typing on S1 with an AI turn and a press.
await sleep(10000);
const markers = [];
let c = await call(P1, `/command?room=${ROOM}&kind=ai`);
markers.push(c.marker);
say(`${at()} AI turn on S1 acked after flush ${c.flushMs} ms (${c.bytes} B update)`);
await sleep(10000);
c = await call(P1, `/command?room=${ROOM}&kind=press`);
markers.push(c.marker);
say(`${at()} press on S1 acked after flush ${c.flushMs} ms`);
await sleep(10000);

// 2. Deploy overlap: S2 starts; tabs 5-9 reconnect to it while 0-4 stay on S1. Both save the same room.
const s2 = await startServer("S2", P2);
say(`${at()} S2 pid ${s2.pid} on ${P2}; tabs 5-9 move to S2`);
for (const t of tabs.slice(5)) t.setUrl(`ws://127.0.0.1:${P2}`);
await sleep(10000);
c = await call(P2, `/command?room=${ROOM}&kind=ai`);
markers.push(c.marker);
say(`${at()} AI turn on S2 during the overlap, flush ${c.flushMs} ms`);
await sleep(10000);
const overlapSaves = serverLog().filter((e) => e.ev === "save");
say(
  `${at()} overlap saves: S1 ${serverLog().filter((e) => e.ev === "save" && e.server === "S1").length}, S2 ${serverLog().filter((e) => e.ev === "save" && e.server === "S2").length}, merged-before-save ${overlapSaves.filter((e) => e.merged).length} (S1 ${overlapSaves.filter((e) => e.merged && e.server === "S1").length}, S2 ${overlapSaves.filter((e) => e.merged && e.server === "S2").length})`,
);
s1.kill("SIGTERM");
await new Promise((r) => s1.on("exit", r));
say(`${at()} S1 stopped (SIGTERM, final flush); tabs 0-4 move to S2`);
for (const t of [...tabs.slice(0, 5), solo]) t.setUrl(`ws://127.0.0.1:${P2}`);
await sleep(10000);
await quiesce();
await converged(P2, "after the overlap");
await call(P2, `/flush?room=${ROOM}`);
let l = await lossCheck("after the overlap");
say(
  `${at()} DB after the overlap: acked ops missing ${l.ackedMissing}, typed ops missing ${l.typedMissing}, markers present ${markers.filter((m) => l.text.includes(m)).length}/${markers.length}`,
);
typing = true;

// 3. Kill -9 immediately after an AI turn's and a press's acks.
await sleep(5000);
const ai = await call(P2, `/command?room=${ROOM}&kind=ai`),
  press = await call(P2, `/command?room=${ROOM}&kind=press`);
markers.push(ai.marker, press.marker);
process.kill(s2.pid, "SIGKILL");
const killAt1 = Date.now();
say(`${at()} kill -9 S2 (pid ${s2.pid}) right after AI and press acks`);
l = await lossCheck();
say(
  `${at()} DB at kill 1: AI marker ${l.text.includes(ai.marker)}, press marker ${l.text.includes(press.marker)}; acked ops not in DB ${l.ackedMissing}; typed ops not in DB ${l.typedMissing}`,
);
// Tab 3 is closed and reopened from its store during the outage (a reload while the server is down).
await sleep(700);
{
  const old = tabs[3];
  closedSessions.push({
    peer: old.peer,
    acked: old.acked,
    typed: old.doc.oplogVersion().get(old.peer) ?? 0,
  });
  old.close();
  tabs[3] = new Tab({
    id: 3,
    url: `ws://127.0.0.1:${P2}`,
    room: ROOM,
    storePath: `${OUT}/stores/tab3.bin`,
    rng: rng(300),
    reopen: true,
  });
}
await sleep(800);
const s3 = await startServer("S3", P2);
say(
  `${at()} S3 pid ${s3.pid} restarted on ${P2} after ${((Date.now() - killAt1) / 1000).toFixed(1)} s down; tabs reconnect`,
);
await sleep(15000);

// 4. Kill -9 mid-window: typing continuous, at least 5 s since the room's last save.
for (let i = 0; i < 200; i++) {
  const s = lastSave();
  if (s?.server === "S3" && Date.now() - s.wall > 5000) break;
  await sleep(100);
}
const ls = lastSave();
process.kill(s3.pid, "SIGKILL");
const killAt2 = Date.now();
l = await lossCheck();
say(
  `${at()} kill -9 S3 (pid ${s3.pid}) mid-window, ${((killAt2 - ls.wall) / 1000).toFixed(1)} s after its last save (${ls.reason}); acked ops not in DB ${l.ackedMissing}; typed ops not in DB ${l.typedMissing}`,
);
// During this outage tab 9 closes for good (other tabs hold its broadcast ops), and so does the solo writer
// (nobody else holds its ops): the acked-but-unsaved ops of a writer whose only copy closes are the loss window.
await sleep(300);
const soloAtKill = {
  keysLost: solo.keysAt(killAt2) - solo.keysAt(lastSave(SOLO_ROOM).wall),
  peer: solo.peer,
  acked: solo.acked,
  typed: solo.doc.oplogVersion().get(solo.peer) ?? 0,
  sinceSave: (killAt2 - lastSave(SOLO_ROOM).wall) / 1000,
};
solo.close();
{
  const t9 = tabs.pop();
  closedSessions.push({
    peer: t9.peer,
    acked: t9.acked,
    typed: t9.doc.oplogVersion().get(t9.peer) ?? 0,
  });
  t9.close();
}
await sleep(1700);
const s4 = await startServer("S4", P2);
say(
  `${at()} S4 pid ${s4.pid} restarted after ${((Date.now() - killAt2) / 1000).toFixed(1)} s down`,
);
await sleep(10000);

// 5. Final convergence and durability.
await quiesce();
const ok = await converged(P2, "final");
await call(P2, `/flush?room=${ROOM}`);
l = await lossCheck();
say(
  `${at()} final DB: acked ops missing ${l.ackedMissing}, typed ops missing ${l.typedMissing}, markers present ${markers.filter((m) => l.text.includes(m)).length}/${markers.length} (includes tab 9, closed for good in the outage)`,
);
{
  const d = await dbDoc(SOLO_ROOM);
  const have = d.oplogVersion().get(soloAtKill.peer) ?? 0;
  d.free();
  say(
    `${at()} solo writer closed during the outage: ${soloAtKill.acked - have} acked ops lost (${soloAtKill.typed - have} typed, ${soloAtKill.keysLost} keystrokes in that window), last save ${soloAtKill.sinceSave.toFixed(1)} s before the kill; the DB holds ${have} of its ${soloAtKill.acked} acked ops`,
  );
}
clearInterval(typer);
// The solo writer comes back later: the tab reopens from its store and resends what the room lacks.
{
  const back = new Tab({
    id: 11,
    url: `ws://127.0.0.1:${P2}`,
    room: SOLO_ROOM,
    storePath: `${OUT}/stores/solo.bin`,
    rng: rng(111),
    reopen: true,
  });
  for (let i = 0; i < 50 && !(back.joined && back.inflight.size === 0); i++) await sleep(100);
  await sleep(300);
  await call(P2, `/flush?room=${SOLO_ROOM}`);
  const d = await dbDoc(SOLO_ROOM);
  const have = d.oplogVersion().get(soloAtKill.peer) ?? 0;
  d.free();
  back.close();
  say(
    `${at()} solo writer reopened from its store: DB now holds ${have} of its ${soloAtKill.acked} acked ops (${soloAtKill.typed} typed)`,
  );
}

// Save latency and sizes.
const saves = serverLog().filter((e) => e.ev === "save");
const q = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const ms = saves.map((s) => s.ms),
  ex = saves.map((s) => s.exportMs),
  by = saves.map((s) => s.bytes);
say(
  `saves ${saves.length} (${Object.entries(Object.groupBy(saves, (s) => s.reason))
    .map(([k, v]) => `${k} ${v.length}`)
    .join(", ")}); merged ${saves.filter((s) => s.merged).length}`,
);
say(
  `save ms (tx incl. export): p50 ${q(ms, 0.5)} p90 ${q(ms, 0.9)} p99 ${q(ms, 0.99)} max ${Math.max(...ms)}; export ms p50 ${q(ex, 0.5)} max ${Math.max(...ex)}`,
);
say(`snapshot bytes: first ${by[0]} p50 ${q(by, 0.5)} last ${by.at(-1)}`);
const acks = tabs.flatMap((t) => t.ackLatency);
say(
  `keystroke batch ack ms: p50 ${q(acks, 0.5).toFixed(2)} p99 ${q(acks, 0.99).toFixed(2)} (${acks.length} batches)`,
);
for (const s of [...saves].filter((s) => s.reason !== "debounce"))
  say(`  ${s.server} ${s.reason} ${s.ms} ms merged=${s.merged}`);
writeFileSync(`${OUT}/report.txt`, `${report.join("\n")}\n`);

for (const t of tabs) t.close();
s4.kill("SIGTERM");
await new Promise((r) => s4.on("exit", r));
await sql.end();
await admin.unsafe(`drop database ${DB}`);
await admin.end();
say(
  `server pids ${servers.map((s) => `${s.name}=${s.pid}`).join(" ")}; database ${DB} dropped; converged ${ok}`,
);
writeFileSync(`${OUT}/report.txt`, `${report.join("\n")}\n`);
process.exit(0);
