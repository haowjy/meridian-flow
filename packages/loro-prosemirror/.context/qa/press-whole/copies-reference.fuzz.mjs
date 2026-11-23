// Seeded fuzz of copies-reference.mjs on one text doc: Live, a draft's room copy and a Draft tab's
// copy (each fork copy with its own Live copy, synced at random), word-sized edits on both sides,
// Discards, Applies and Undos of Live edits.
// Run: node .context/qa/press-whole/copies-reference.fuzz.mjs [--n 500] [--start 0] [--seed N]
import { apply, describe, discard, docOf, forward, idsAt, oneCopy, read, T, takeBack } from "./copies-reference.mjs";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? fallback : Number(process.argv[at + 1]);
};
const one = arg("seed", -1);
const start = one >= 0 ? one : arg("start", 0);
const n = one >= 0 ? 1 : arg("n", 300);
const trace = one >= 0;

function rng(seed) {
  let a = (seed + 1) * 0x9e3779b1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const totals = { seeds: 0, failed: 0, clashes: 0, putBack: 0, liveEdits: 0, kept: 0, keptOut: 0, applies: 0, discards: 0, liveUndos: 0 };
const failures = [];

for (let seed = start; seed < start + n; seed++) {
  const rand = rng(seed);
  const pick = (k) => Math.floor(rand() * k);
  let word = 0;
  const fresh = (who) => `${who}${word++}`;
  let peer = 1 + pick(50);
  const nextPeer = () => String(peer++ * 7 + pick(7));
  const stats = {};
  const live = docOf(nextPeer());
  live.getText(T).insert(0, `${Array.from({ length: 8 }, () => fresh("s")).join(" ")} `);
  live.commit();
  const room = docOf(nextPeer(), live);
  const roomLive = docOf(nextPeer(), live);
  const tab = docOf(nextPeer(), live);
  const tabLive = docOf(nextPeer(), live);
  const fail = (why) => {
    throw new Error(why);
  };
  const words = (doc) => read(doc).split(" ").filter(Boolean);
  const pull = (into, from) => into.import(from.export({ mode: "update", from: into.oplogVersion() }));
  const syncRoom = () => {
    pull(roomLive, live);
    forward(room, roomLive, stats);
  };
  const syncTab = () => {
    pull(tabLive, live);
    forward(tab, tabLive, stats);
    pull(tab, room);
    oneCopy(tab);
    pull(room, tab);
    oneCopy(room);
    pull(tab, room);
    oneCopy(tab);
  };
  /** Replace words [at, at + count) of `doc` with `put` (a string, may be empty); key by key or at once. */
  const edit = (doc, at, count, put, after = () => {}) => {
    const t = doc.getText(T);
    const all = read(doc);
    // Word starts, by position.
    const starts = [];
    for (let i = 0; i < all.length; i++) if (all[i] !== " " && (i === 0 || all[i - 1] === " ")) starts.push(i);
    const from = at < starts.length ? starts[at] : all.length;
    const to = at + count < starts.length ? starts[at + count] : all.length;
    // Every word ends with its space, so two words typed at one gap stay two words.
    const textIn = put ? `${put} ` : "";
    if (rand() < 0.5 || textIn.length === 0) {
      if (to > from) t.delete(from, to - from);
      if (textIn) t.insert(from, textIn);
      doc.commit();
      after();
    } else {
      if (to > from) t.delete(from, to - from);
      t.insert(from, textIn[0]);
      doc.commit();
      after();
      for (let i = 1; i < textIn.length; i++) {
        t.insert(from + i, textIn[i]);
        doc.commit();
        if (rand() < 0.5) after();
      }
      after();
    }
  };
  const noTwice = (name, doc) => {
    const list = words(doc);
    const seen = new Set();
    for (const w of list) {
      if (seen.has(w)) fail(`${name} shows "${w}" twice: ${read(doc)}`);
      seen.add(w);
    }
    for (const w of list) if (!/^[sld]\d+$/.test(w)) fail(`${name} holds a woven word "${w}": ${read(doc)}`);
  };
  const draftTyped = new Set();
  const liveUndo = [];
  try {
    const steps = 12 + pick(25);
    for (let step = 0; step < steps; step++) {
      const r = rand();
      if (r < 0.34) {
        // A Live edit: replace 0 to 2 words with 0 to 2 words.
        syncRoom();
        const list = words(live);
        const at = pick(list.length + 1);
        const count = Math.min(pick(3), list.length - at);
        const put = Array.from({ length: pick(3) }, () => fresh("l")).join(" ");
        if (count === 0 && !put) continue;
        const roomHas = new Set(words(room));
        const replaced = list.slice(at, at + count);
        const before = live.frontiers();
        edit(live, at, count, put, () => rand() < 0.6 && syncRoom());
        liveUndo.push({ before, after: live.frontiers() });
        syncRoom();
        totals.liveEdits++;
        if (!put) continue;
        const draftDeleted = (w) => w !== undefined && !roomHas.has(w);
        const clash = replaced.some(draftDeleted);
        const outside =
          replaced.every((w) => !draftDeleted(w)) && !draftDeleted(list[at - 1]) && !draftDeleted(list[at + count]);
        const got = put.split(" ").filter((w) => words(room).includes(w)).length;
        if (clash) {
          totals.keptOut++;
          if (got > 0) fail(`Live replaced a word the draft deleted, and its text is in the draft: ${read(room)} | Live ${read(live)}`);
        } else if (outside) {
          totals.kept++;
          if (got < put.split(" ").length) fail(`Live typing outside what the draft replaced is not in the draft: ${read(room)} | Live ${read(live)}`);
        }
      } else if (r < 0.68) {
        // A draft edit, in the room copy or the tab.
        const doc = rand() < 0.5 ? room : tab;
        if (doc === tab && rand() < 0.5) syncTab();
        const list = words(doc);
        const at = pick(list.length + 1);
        const count = Math.min(pick(3), list.length - at);
        const put = Array.from({ length: pick(3) }, () => fresh("d")).join(" ");
        if (count === 0 && !put) continue;
        for (const w of list.slice(at, at + count)) draftTyped.delete(w);
        edit(doc, at, count, put);
        for (const w of put.split(" ").filter(Boolean)) draftTyped.add(w);
      } else if (r < 0.8) {
        syncTab();
      } else if (r < 0.87 && liveUndo.length > 0) {
        // Live takes its last edit back, when nothing wrote Live since.
        const last = liveUndo.pop();
        if (JSON.stringify(last.after) !== JSON.stringify(live.frontiers())) continue;
        takeBack(live, last);
        oneCopy(live);
        liveUndo.length = 0;
        totals.liveUndos++;
        syncRoom();
      } else if (r < 0.94) {
        syncTab();
        syncRoom();
        const want = read(room);
        pull(roomLive, live);
        apply(room, roomLive);
        pull(live, roomLive);
        oneCopy(live);
        if (read(live) !== want) fail(`Apply left Live "${read(live)}", the draft read "${want}"`);
        draftTyped.clear();
        liveUndo.length = 0;
        totals.applies++;
      } else {
        syncTab();
        syncRoom();
        discard(room, roomLive);
        if (read(room) !== read(live)) fail(`Discard left the draft "${read(room)}", Live reads "${read(live)}"`);
        draftTyped.clear();
        syncTab();
        totals.discards++;
      }
      if (trace) console.log(`${step}\n  L ${read(live)}\n  R ${read(room)}\n  T ${read(tab)}`);
      if (trace && process.env.COPIES_IDS) {
        const ids = idsAt(live, live.frontiers());
        console.log("  L ids", [...read(live)].map((ch, i) => `${ch}=${ids[i]}`).join(" "));
        const rids = idsAt(room, room.frontiers());
        console.log("  R ids", [...read(room)].map((ch, i) => `${ch}=${rids[i]}`).join(" "));
      }
      noTwice("Live", live);
      noTwice("the room copy", room);
      for (const w of draftTyped)
        if (!words(room).includes(w) && !words(tab).includes(w)) fail(`the draft's own "${w}" is gone: ${read(room)}`);
    }
    syncRoom();
    syncTab();
    syncTab();
    noTwice("the tab copy", tab);
    if (read(room) !== read(tab)) fail(`copies differ: room "${read(room)}" tab "${read(tab)}"`);
    for (const w of draftTyped) if (!words(room).includes(w)) fail(`the draft's own "${w}" is gone at the end: ${read(room)}`);
  } catch (error) {
    totals.failed++;
    failures.push(`seed ${seed}: ${error.message}`);
    if (trace) console.log(error.stack);
    if (trace && process.env.COPIES_TRACE) console.log(describe(live).join("\n"));
    if (trace && process.env.COPIES_OPS)
      for (const spec of process.env.COPIES_OPS.split(",")) {
        const [p, from, to] = spec.split(":");
        for (const doc of [live, room])
          console.log(doc === live ? "LIVE" : "ROOM", spec, JSON.stringify(doc.exportJsonInIdSpan({ peer: p, counter: Number(from), length: Number(to) - Number(from) }).map((c) => ({ id: c.id, lamport: c.lamport, msg: c.msg, ops: c.ops.map((o) => ({ counter: o.counter, ...o.content })) }))));
      }
  }
  totals.seeds++;
  totals.clashes += stats.clashes ?? 0;
  totals.putBack += stats.putBack ?? 0;
}
for (const line of failures.slice(0, 25)) console.log(line);
console.log("SUMMARY", JSON.stringify(totals));
process.exit(totals.failed === 0 ? 0 : 1);
