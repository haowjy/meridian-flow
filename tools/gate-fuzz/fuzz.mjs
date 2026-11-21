// Phase 0 gate 2: the block-diff model on the real schema, fuzzed.
//   node --import tsx fuzz.mjs --n 10000 [--start 0] [--approach A|B] [--reshare] [--seed S --verbose]
// One script: a Live document; a Live tab; on the draft's first write a server fork and a Draft tab on it;
// 1–8 draft edits (the writer in the tab, AI turns on the server fork) with fork-side Ctrl+Z and concurrent Live
// edits; then presses of random blocks by id, their Undo while the fork holds typing, single-block Reset and its
// Undo, a chapter Discard (approach A or B) with its Undo, a stale offline Draft tab, frontier Restore before; then
// Apply-all. Every step checks the content it should leave; the end checks Live == fork and nothing pending.
import { UndoManager } from "loro-crdt";
import {
  captureDelta,
  changeStateIn,
  editChanges,
  readDelta,
  takeOut,
} from "../../packages/agent-edit/src/content-merge/index.ts";
import * as M from "./block-diff.mjs";
import {
  checkReal,
  copyOf,
  edit,
  forkOf,
  freeAll,
  fromReal,
  newDoc,
  read,
  realSchema,
  schema,
  takeBindingErrors,
  toReal,
  track,
  withIds,
  writeDoc,
} from "./codec.mjs";
import { Gen, randomEdit, TOKEN } from "./gen.mjs";

class Fail extends Error {
  constructor(cls, msg) {
    super(`${cls}: ${msg}`);
    this.cls = cls;
  }
}
/** The blocks where two renders differ, short. */
function showDiff(a, b, la = "a", lb = "b") {
  const A = JSON.parse(a);
  const B = JSON.parse(b);
  const out = [];
  const short = (x) => (x ?? "(none)").replace(/\\"/g, '"').slice(0, 400);
  for (let i = 0; i < Math.max(A.length, B.length) && out.length < 6; i++)
    if (A[i] !== B[i]) out.push(`  #${i} ${la}: ${short(A[i])}\n  #${i} ${lb}: ${short(B[i])}`);
  return `${A.length} vs ${B.length} blocks\n${out.join("\n")}`;
}
/** Same blocks in another order. */
const reordered = (a, b) =>
  a !== b && JSON.stringify(JSON.parse(a).sort()) === JSON.stringify(JSON.parse(b).sort());
const check = (cond, cls, msg) => {
  if (!cond) throw new Fail(cls, typeof msg === "function" ? msg() : msg);
};

// --- reading documents ---
const rootList = (doc) => doc.getMap("doc").get("children");
const idOf = (c) => c.get("attributes")?.get("id") ?? null;
/** id → { cid, value } for each top-level block. */
function blocksById(doc) {
  const out = new Map();
  for (const c of rootList(doc).toArray())
    out.set(idOf(c), { cid: c.id, value: M.blockValue(doc, c) });
  return out;
}
/** The whole document's content: block values in order. */
const render = (doc) =>
  JSON.stringify(
    rootList(doc)
      .toArray()
      .map((c) => M.blockValue(doc, c)),
  );
const tokens = (doc) => {
  const pm = read(doc);
  return pm.textBetween(0, pm.content.size, " ", " ").match(TOKEN) ?? [];
};
const pendingIds = (live, fork) => {
  const d = M.changedBlocks(live, fork);
  return { d, ids: new Set(d.changes.flatMap((ch) => [...ch.ids])) };
};
const bodies = (doc) => doc.getMap(M.COMMENTS).toJSON();
function carried(doc) {
  const out = new Set();
  for (const m of render(doc).matchAll(/comment_(c\d+)/g)) out.add(m[1]);
  return out;
}

// --- content takeBack (main's inverse-text rule), on the real schema ---
const realBlocks = (doc) => toReal(read(doc)).content.content;
function takeBack(current, before, after) {
  const stored = captureDelta(before, after);
  if (!stored) return current;
  let blocks = current;
  for (const change of editChanges(realSchema, readDelta(realSchema, stored))) {
    if (changeStateIn(realSchema, change, blocks) !== "stands") continue;
    blocks = takeOut(realSchema, change, blocks);
  }
  return blocks;
}
/** Write `blocks` (real schema) into `doc` through the binding, giving back the bodies `oldBodies` held for marks it restores. */
function writeBlocks(doc, blocks, oldBodies, message) {
  const pm = fromReal(realSchema.nodes.doc.create(null, blocks));
  writeDoc(doc, pm, message);
  const map = doc.getMap(M.COMMENTS);
  for (const k of carried(doc))
    if (map.get(k) === undefined && oldBodies[k] !== undefined) map.set(k, oldBodies[k]);
  M.dropOrphanBodies(doc);
  doc.commit({ message });
}

export function runScript(
  seed,
  { approach = "B", reshare = false, undo = "takeBack", verbose = false } = {},
) {
  const g = new Gen(seed);
  const log = [];
  const note = (s) => {
    log.push(s);
    if (verbose) console.log(s);
  };
  const stats = {
    edits: 0,
    presses: 0,
    applied: 0,
    pressUndos: 0,
    resets: 0,
    resetUndos: 0,
    discards: 0,
    discardUndos: 0,
    restores: 0,
    ctrlz: 0,
    liveEdits: 0,
    stale: 0,
    kinds: {},
  };
  const outcomes = [];

  // World
  const live = newDoc("1");
  writeDoc(live, withIds(g.initialDoc(), g.rng), "init");
  live.commit();
  // seed comments in Live, with bodies
  if (g.chance(0.6)) {
    edit(
      live,
      (tr, d) => {
        const e = randomEdit(g, d, "s", { structure: false });
        if (e?.kind !== "comment" && e?.kind !== "comment2") return null;
        for (const [id, b] of e.comments) live.getMap(M.COMMENTS).set(id, b);
        return e.build(tr, d);
      },
      { rng: g.rng },
    );
    live.commit();
  }
  const liveTab = copyOf(live, "2");
  let fork = null; // the server's fork document
  let tab = null; // the Draft tab's fork copy
  let um = null; // the Draft tab's Ctrl+Z
  let linked = true; // approach A: whether the fork is linked
  let generation = 0;
  let parked = []; // approach A: unlinked forks held for Undo
  let peerN = 100;
  const nextPeer = () => String(++peerN);

  // Oracle state
  const deleted = new Set(); // tokens a user edit removed
  const removed = new Set(); // draft tokens a server op or Ctrl+Z took out of the fork
  const liveTokenBlock = new Map(); // Live token → the block id it was typed into
  const touched = new Set(); // block ids a draft user edit changed
  const recreated = new Map(); // block id → what last gave the fork its own container for it

  const syncLive = () => {
    live.import(liveTab.export({ mode: "update", from: live.oplogVersion() }));
    liveTab.import(live.export({ mode: "update", from: liveTab.oplogVersion() }));
    if (fork) M.forward(live, fork);
  };
  const share = () => {
    if (!reshare || !fork || !linked) return;
    const n = M.reshare(live, fork);
    if (n) {
      stats.reshared = (stats.reshared ?? 0) + n;
      liveTab.import(live.export({ mode: "update", from: liveTab.oplogVersion() }));
      for (const [id, b] of blocksById(fork))
        if (blocksById(live).get(id)?.cid === b.cid) recreated.delete(id);
    }
  };
  const syncTab = () => {
    if (!fork) return;
    fork.import(tab.export({ mode: "update", from: fork.oplogVersion() }));
    M.forward(live, fork);
    share();
    tab.import(fork.export({ mode: "update", from: tab.oplogVersion() }));
  };
  const toTab = () => {
    share();
    tab.import(fork.export({ mode: "update", from: tab.oplogVersion() }));
  };
  const ensureFork = () => {
    if (fork && linked) return;
    syncLive();
    fork = forkOf(live, String(10 + generation * 1000));
    generation++;
    linked = true;
    tab = copyOf(fork, nextPeer());
    um = track(new UndoManager(tab, { mergeInterval: 0, maxUndoSteps: 200 }));
    note(`fork created (generation ${generation})`);
  };

  // Track what a fork-changing step did to block ids and containers, and which tokens it removed.
  const splitMoved = new Set(); // tokens a split or join moved into another block: a partial Apply of one half may double them
  const tokenBlocks = (doc) => {
    const m = new Map();
    for (const c of rootList(doc).toArray())
      for (const t of tokensOfBlock(doc, c)) m.set(t, idOf(c));
    return m;
  };
  const watch = (doc, label, { user = false } = {}) => {
    const before = blocksById(doc);
    const tok = tokens(doc);
    const tb0 = label === "user:split" || label === "user:join" ? tokenBlocks(doc) : null;
    return () => {
      if (tb0)
        for (const [t, id] of tokenBlocks(doc))
          if (tb0.has(t) && tb0.get(t) !== id) splitMoved.add(t);
      const after = blocksById(doc);
      const tok2 = new Set(tokens(doc));
      for (const t of tok)
        if (!tok2.has(t)) (user ? deleted : t[0] === "f" || t[0] === "a" ? removed : null)?.add(t);
      for (const [id, a] of after) {
        const b = before.get(id);
        if (user && (!b || b.value !== a.value || b.cid !== a.cid)) touched.add(id);
        if (b && b.cid !== a.cid) recreated.set(id, label);
        if (!b) recreated.set(id, label);
      }
      if (user) for (const [id] of before) if (!after.has(id)) touched.add(id);
    };
  };
  const commentsIn = (doc) => [...carried(doc)];
  const userEdit = (doc, origin, opts = {}) => {
    const pm = read(doc);
    const e = randomEdit(g, pm, origin, { commentsHere: commentsIn(doc), ...opts });
    if (!e) return null;
    const done = doc === liveTab ? null : watch(doc, `user:${e.kind}`, { user: true });
    const ltok = doc === liveTab ? new Set(tokens(doc)) : null;
    const ltokBefore = doc === liveTab ? tokens(doc) : null;
    for (const [id, b] of e.comments ?? []) doc.getMap(M.COMMENTS).set(id, b);
    let changed = false;
    if (e.build) changed = edit(doc, e.build, { rng: g.rng, message: opts.message });
    else changed = !!e.comments;
    doc.commit({ message: opts.message });
    done?.();
    if (doc === liveTab && (e.kind === "split" || e.kind === "join"))
      for (const t of tokens(doc)) splitMoved.add(t);
    if (doc === liveTab) {
      const now = tokens(doc);
      const nowSet = new Set(now);
      for (const t of ltokBefore) if (!nowSet.has(t)) deleted.add(t);
      const byId = new Map();
      for (const c of rootList(doc).toArray())
        for (const t of tokensOfBlock(doc, c)) byId.set(t, idOf(c));
      for (const t of now) if (!ltok.has(t) && t[0] === "l") liveTokenBlock.set(t, byId.get(t));
    }
    stats.kinds[e.kind] = (stats.kinds[e.kind] ?? 0) + 1;
    note(`  ${origin} ${e.kind}${changed ? "" : " (no change)"}`);
    return changed ? e : null;
  };
  const tokensOfBlock = (doc, c) => {
    const s = M.blockValue(doc, c);
    return s.match(TOKEN) ?? [];
  };

  const liveEdit = (structure = g.chance(0.3)) => {
    userEdit(liveTab, "l", { structure });
    stats.liveEdits++;
    if (g.chance(0.8)) syncLive();
  };
  const writerEdit = () => {
    ensureFork();
    const before = render(tab);
    const e = userEdit(tab, "f");
    stats.edits++;
    // Ctrl+Z right after, before anything else arrives: the tab is back to before the edit
    if (e && g.chance(0.18)) {
      const done = watch(tab, "ctrlz");
      um.undo();
      tab.commit();
      done();
      stats.ctrlz++;
      note("  writer Ctrl+Z");
      check(
        render(tab) === before,
        "ctrlz",
        () => `tab not back to before the edit\n${showDiff(before, render(tab), "before", "now")}`,
      );
    }
    if (g.chance(0.6)) syncTab();
  };

  const aiTurn = (n) => {
    ensureFork();
    syncTab();
    const turn = nextPeer();
    fork.setPeerId(turn);
    const beforeTurn = fork.frontiers();
    const shadow = copyOf(fork, nextPeer()); // the fork before the turn, kept up with Live: what Restore before must give back
    for (let i = 0; i < n; i++) {
      userEdit(fork, "a", { message: `turn:${turn}` });
      stats.edits++;
    }
    fork.setPeerId(nextPeer());
    tab.import(fork.export({ mode: "update", from: tab.oplogVersion() }));
    return { beforeTurn, shadow, turn };
  };

  const pressSubset = () => {
    syncLive();
    syncTab();
    const { d } = pendingIds(live, fork);
    if (!d.changes.length) return null;
    const chosen = d.changes.filter(() => g.chance(0.5));
    if (!chosen.length) chosen.push(g.pick(d.changes));
    const ids = chosen.map((ch) => g.pick([...ch.ids]));
    const ids2 = new Set(resolveIds(d, ids));
    const liveBefore = render(live);
    const liveBlocks = blocksById(live);
    const forkBefore = render(fork);
    const realBefore = realBlocks(live);
    const bodiesBefore = bodies(live);
    const done = watch(fork, "apply");
    const r = M.applyBlocks(live, fork, ids, `press:${seed}-${stats.presses}`);
    done();
    for (const id of ids2) recreated.delete(id);
    stats.presses++;
    stats.applied += r.chosen.length;
    note(`press ${ids.join(",")} → ${r.chosen.length} change(s)`);
    // expected: the fork shows what it showed; the chosen blocks are Live's now; the rest of Live is untouched
    check(
      render(fork) === forkBefore,
      reordered(forkBefore, render(fork)) ? "apply-reorder" : "apply",
      () => `fork changed by the press\n${showDiff(forkBefore, render(fork), "before", "after")}`,
    );
    const lb = blocksById(live);
    const fb = blocksById(fork);
    for (const id of ids2)
      check(
        (lb.get(id)?.value ?? null) === (fb.get(id)?.value ?? null),
        "apply",
        () =>
          `block ${id} not equal after its Apply\n live ${lb.get(id)?.value}\n fork ${fb.get(id)?.value}`,
      );
    for (const [id, b] of liveBlocks)
      if (!ids2.has(id) && lb.has(id))
        check(
          lb.get(id).value === b.value || sharesComment(b.value, ids2, liveBlocks),
          "apply",
          () => `unchosen block ${id} changed in Live`,
        );
    const after = pendingIds(live, fork).ids;
    for (const id of ids2)
      check(!after.has(id), "apply", () => `block ${id} still pending after its Apply`);
    // pressing the same blocks again is a no-op
    const again = M.applyBlocks(live, fork, ids, "press:again");
    check(again.noop, "apply", "a second press of the same blocks changed something");
    return { ids, ids2, liveBefore, realBefore, realAfter: realBlocks(live), bodiesBefore, r };
  };
  const sharesComment = (value, ids, liveBlocks) => /comment_/.test(value); // a cross-block comment's body may move with another block

  const pressUndo = (press, { liveSince }) => {
    syncTab();
    M.forward(live, fork);
    const forkBefore = render(fork);
    let undoBytes;
    if (undo === "inverse")
      undoBytes = M.invertCommit(live, press.r.before, press.r.after, nextPeer(), "undo:press");
    else {
      const v0 = live.oplogVersion();
      writeBlocks(
        live,
        takeBack(realBlocks(live), press.realBefore, press.realAfter),
        press.bodiesBefore,
        "undo:press",
      );
      undoBytes = live.export({ mode: "update", from: v0 });
    }
    liveTab.import(live.export({ mode: "update", from: liveTab.oplogVersion() }));
    const done = watch(fork, "press-undo");
    M.returnToPending(fork, undoBytes, "undo:press");
    done();
    toTab();
    for (const id of press.ids2) touched.add(id);
    stats.pressUndos++;
    note("press Undo");
    check(
      render(fork) === forkBefore,
      "press-undo",
      () => `fork changed by the Undo\n${showDiff(forkBefore, render(fork), "before", "after")}`,
    );
    if (!liveSince)
      check(
        render(live) === press.liveBefore,
        reordered(press.liveBefore, render(live)) ? "press-undo-reorder" : "press-undo",
        () =>
          `Live not back to before the press\n${showDiff(press.liveBefore, render(live), "before", "now")}`,
      );
  };

  const resetOne = () => {
    syncTab();
    const { d } = pendingIds(live, fork);
    if (!d.changes.length) return null;
    const ch = g.pick(d.changes);
    const id = g.pick([...ch.ids]);
    const ids2 = new Set(resolveIds(d, [id]));
    const forkBlocks = blocksById(fork);
    const before = {
      render: render(fork),
      real: realBlocks(fork),
      bodies: bodies(fork),
      pending: new Set(touched),
    };
    const done = watch(fork, "reset");
    const r = M.resetBlocks(live, fork, [id], "reset");
    done();
    toTab();
    if (r.after) r.after = fork.frontiers(); // the Undo takes back the reshare with the Reset
    stats.resets++;
    note(`reset ${id}`);
    const lb = blocksById(live);
    const fb = blocksById(fork);
    for (const x of ids2)
      check(
        (lb.get(x)?.value ?? null) === (fb.get(x)?.value ?? null),
        "reset",
        () =>
          `block ${x} not Live's after Reset\n live ${lb.get(x)?.value}\n fork ${fb.get(x)?.value}`,
      );
    for (const [x, b] of forkBlocks)
      if (!ids2.has(x) && fb.has(x))
        check(
          fb.get(x).value === b.value || /comment_/.test(b.value),
          "reset",
          () => `other block ${x} changed by Reset`,
        );
    check(
      ![...ids2].some((x) => pendingIds(live, fork).ids.has(x)),
      "reset",
      `block ${id} still pending after Reset`,
    );
    for (const x of ids2) touched.delete(x);
    return { before, after: realBlocks(fork), ids2, r };
  };
  const resetUndo = (rec) => {
    syncTab();
    const done = watch(fork, "reset-undo");
    if (undo === "inverse")
      M.invertCommit(fork, rec.r.before, rec.r.after, nextPeer(), "undo:reset");
    else
      writeBlocks(
        fork,
        takeBack(realBlocks(fork), rec.before.real, rec.after),
        rec.before.bodies,
        "undo:reset",
      );
    done();
    toTab();
    for (const x of rec.before.pending) touched.add(x);
    stats.resetUndos++;
    note("reset Undo");
    check(
      render(fork) === rec.before.render,
      reordered(rec.before.render, render(fork)) ? "reset-undo-reorder" : "reset-undo",
      () =>
        `fork not back to before the Reset\n${showDiff(rec.before.render, render(fork), "before", "now")}`,
    );
  };

  // --- chapter Discard: A (unlink) or B (Reset every change in the one fork) ---
  const discard = () => {
    syncTab();
    syncLive();
    const discardedTokens = new Set(
      tokens(fork).filter((t) => (t[0] === "f" || t[0] === "a") && !tokens(live).includes(t)),
    );
    const draftInserted = new Set(
      [...blocksById(fork).keys()].filter((id) => !blocksById(live).has(id)),
    );
    // an offline Draft tab: it has everything so far, then goes offline and keeps typing
    const stale = g.chance(0.5) ? { doc: copyOf(tab, nextPeer()), typed: [] } : null;
    stats.discards++;
    let rec;
    if (approach === "A") {
      parked.push(fork);
      rec = { fork, render: render(fork) };
      linked = false;
      note("discard (A: unlink)");
    } else {
      const before = {
        render: render(fork),
        real: realBlocks(fork),
        bodies: bodies(fork),
        pending: new Set(touched),
      };
      const done = watch(fork, "discard");
      const r = M.resetBlocks(live, fork, "all", "discard");
      done();
      toTab();
      if (r.after) r.after = fork.frontiers();
      rec = { before, after: realBlocks(fork), r };
      note("discard (B: reset every change)");
      check(
        render(fork) === render(live),
        "discard",
        () =>
          `fork not Live after Discard\n${showDiff(render(live), render(fork), "live", "fork")}`,
      );
      check(pendingIds(live, fork).ids.size === 0, "discard", "pending after Discard");
      touched.clear();
    }
    return { rec, stale, discardedTokens, draftInserted };
  };
  const discardUndo = ({ rec }) => {
    stats.discardUndos++;
    if (approach === "A") {
      // re-link: the parked fork comes back; a generation the draft wrote since is merged into it (one Live history)
      const old = rec.fork;
      parked = parked.filter((f) => f !== old);
      if (linked && fork !== old) {
        old.import(fork.export({ mode: "update", from: old.oplogVersion() }));
        note("discard Undo (A: re-link, merging the newer generation)");
      } else note("discard Undo (A: re-link)");
      fork = old;
      linked = true;
      M.forward(live, fork);
      tab = copyOf(fork, nextPeer());
      um = track(new UndoManager(tab, { mergeInterval: 0, maxUndoSteps: 200 }));
      return;
    }
    syncTab();
    const done = watch(fork, "discard-undo");
    if (undo === "inverse")
      M.invertCommit(fork, rec.r.before, rec.r.after, nextPeer(), "undo:discard");
    else
      writeBlocks(
        fork,
        takeBack(realBlocks(fork), rec.before.real, rec.after),
        rec.before.bodies,
        "undo:discard",
      );
    done();
    toTab();
    for (const x of rec.before.pending) touched.add(x);
    note("discard Undo (B: takeBack)");
    return rec.before.render;
  };
  const staleType = (s) => {
    for (let i = 0, n = 1 + g.int(3); i < n; i++) {
      const before = new Set(tokens(s.doc));
      userEdit(s.doc, "f", { structure: false });
      s.blockOf ??= new Map();
      for (const c of rootList(s.doc).toArray())
        for (const t of tokensOfBlock(s.doc, c)) if (!before.has(t)) s.blockOf.set(t, idOf(c));
      for (const t of tokens(s.doc)) if (!before.has(t)) s.typed.push(t);
    }
  };
  /** The stale tab reconnects. What comes back, what is kept. */
  const staleReconnect = (s, ctx) => {
    stats.stale++;
    const bytes = s.doc.export({ mode: "update", from: (fork ?? live).oplogVersion() });
    const measure = (doc, route) => {
      const vis = new Set(tokens(doc));
      const back = [...ctx.discardedTokens].filter((t) => vis.has(t) && !ctx.undone);
      const kept = s.typed.filter((t) => vis.has(t));
      outcomes.push({ route, back: back.length, typed: s.typed.length, kept: kept.length });
      note(
        `stale tab → ${route}: ${back.length} discarded token(s) back, ${kept.length}/${s.typed.length} typed kept`,
      );
      return { back, kept };
    };
    if (approach === "A") {
      // into its own (parked) room: nothing visible until an Undo; or routed into whatever the draft shows now
      if (linked && fork === ctx.rec.fork) {
        const own = copyOf(fork, nextPeer());
        own.import(s.doc.export({ mode: "update", from: own.oplogVersion() }));
        measure(own, "A:own-room-relinked");
      } else {
        outcomes.push({ route: "A:own-room-unlinked", back: 0, typed: s.typed.length, kept: 0 });
        // to keep the typing the server must put the tab's update into a linked fork: the draft's newer generation, or a fresh one
        const target = linked ? copyOf(fork, nextPeer()) : copyOf(live, nextPeer());
        target.import(s.doc.export({ mode: "update", from: target.oplogVersion() }));
        measure(target, linked ? "A:routed-to-newer-generation" : "A:routed-to-fresh-generation");
      }
      // main line: the parked room takes the tab's update (kept for an Undo)
      ctx.rec.fork.import(s.doc.export({ mode: "update", from: ctx.rec.fork.oplogVersion() }));
      if (linked && fork === ctx.rec.fork)
        tab.import(fork.export({ mode: "update", from: tab.oplogVersion() }));
      return;
    }
    fork.import(bytes);
    M.forward(live, fork);
    tab.import(fork.export({ mode: "update", from: tab.oplogVersion() }));
    const { back, kept } = measure(fork, "B:same-room");
    const lostIn = s.typed
      .filter((t) => !kept.includes(t))
      .map((t) => (ctx.draftInserted.has(s.blockOf.get(t)) ? "draft-inserted-block" : "other"));
    for (const w of lostIn) stats[`staleLost:${w}`] = (stats[`staleLost:${w}`] ?? 0) + 1;
    check(
      back.length === 0,
      "stale-discarded-back",
      () => `discarded text came back: ${back.join(" ")}`,
    );
    for (const t of s.typed) if (!new Set(tokens(fork)).has(t)) removed.add(t);
  };

  const restoreBefore = (turn) => {
    syncTab();
    M.forward(live, fork);
    turn.shadow.import(live.export({ mode: "update", from: turn.shadow.oplogVersion() }));
    const want = render(turn.shadow);
    // design §5 as written, on a copy
    const asWritten = copyOf(fork, nextPeer());
    M.restoreBeforeAsWritten(asWritten, turn.beforeTurn, "restore");
    const okWritten = render(asWritten) === want;
    outcomes.push({ route: "restore-as-written", ok: okWritten, liveSince: turn.liveSince });
    const done = watch(fork, "restore");
    M.restoreBeforeOnLive(live, fork, turn.beforeTurn, "restore");
    done();
    toTab();
    stats.restores++;
    note(`restore before turn ${turn.turn} (as written: ${okWritten ? "ok" : "differs"})`);
    check(
      render(fork) === want,
      "restore",
      () =>
        `fork not the pre-turn draft on today's Live\n${showDiff(want, render(fork), "want", "got")}`,
    );
  };

  // --- the script ---
  try {
    let turn = null;
    const nEdits = 1 + g.int(8);
    let made = 0;
    while (made < nEdits) {
      if (g.chance(0.25)) liveEdit();
      if (g.chance(0.6)) {
        ensureFork();
        writerEdit();
        made++;
      } else {
        const n = Math.min(nEdits - made, 1 + g.int(2));
        const t = aiTurn(n);
        made += n;
        if (!turn && g.chance(0.35)) turn = { ...t, liveSince: false, pressed: false };
      }
    }
    if (g.chance(0.4)) {
      liveEdit();
      if (turn) turn.liveSince = true;
    }
    if (turn && g.chance(0.6)) restoreBefore(turn);

    const actions = 2 + g.int(3);
    for (let a = 0; a < actions; a++) {
      const k = g.r();
      if (!fork || !linked) {
        if (g.chance(0.5)) {
          ensureFork();
          writerEdit();
        }
        continue;
      }
      if (k < 0.45) {
        const press = pressSubset();
        if (press && g.chance(0.55)) {
          // the fork holds typing when the Undo comes; sometimes Live moved on too
          for (let i = 0, n = g.int(3); i < n; i++) {
            userEdit(tab, "f");
          }
          const liveSince = g.chance(0.3);
          if (liveSince) liveEdit(false);
          syncLive();
          pressUndo(press, { liveSince });
        }
      } else if (k < 0.7) {
        const rec = resetOne();
        if (rec && g.chance(0.5)) resetUndo(rec);
      } else if (k < 0.85) {
        const pending = pendingIds(live, fork).ids.size;
        if (!pending) continue;
        const ctx = discard();
        if (ctx.stale) staleType(ctx.stale);
        const order = g.int(3); // 0: Undo first, 1: the draft writes again first, 2: neither
        if (order === 0) {
          const want = discardUndo(ctx);
          ctx.undone = true;
          if (want)
            check(
              render(fork) === want,
              reordered(want, render(fork)) ? "discard-undo-reorder" : "discard-undo",
              () =>
                `fork not back to before the Discard\n${showDiff(want, render(fork), "before", "now")}`,
            );
        } else if (order === 1) {
          aiTurn(1);
        }
        if (ctx.stale) staleReconnect(ctx.stale, ctx);
        if (order === 1 && g.chance(0.5)) {
          discardUndo(ctx);
          ctx.undone = true;
        }
      } else {
        liveEdit();
        if (g.chance(0.5)) {
          writerEdit();
        }
      }
    }

    // --- the end: everything in, Apply-all, Live == fork, nothing pending ---
    syncLive();
    if (fork && linked) {
      syncTab();
      const { d } = pendingIds(live, fork);
      // spurious pending: a block pending that no draft edit touched
      for (const ch of d.changes)
        for (const id of ch.ids)
          if (!touched.has(id))
            check(
              false,
              "spurious-pending",
              () =>
                `block ${id} pending with no draft edit (fork copy from ${recreated.get(id) ?? "?"})`,
            );
      const forkTokens = new Set(tokens(fork));
      const fb = blocksById(fork);
      const lb = blocksById(live);
      for (const [t, id] of liveTokenBlock) {
        if (deleted.has(t) || !new Set(tokens(live)).has(t)) continue;
        if (!forkTokens.has(t) && fb.has(id) && fb.get(id).cid !== lb.get(id)?.cid)
          check(
            false,
            `live-typing-lost:${recreated.get(id) ?? "?"}`,
            `Live's ${t} (block ${id}) is not in the fork's copy of the block`,
          );
      }
      M.applyBlocks(live, fork, "all", "press:all");
      syncTab();
    }
    syncLive();
    const view = fork && linked ? fork : live;
    check(
      render(live) === render(view),
      reordered(render(live), render(view)) ? "converge-reorder" : "converge",
      () => `Live != fork after Apply-all\n${showDiff(render(live), render(view), "live", "fork")}`,
    );
    if (fork && linked)
      check(pendingIds(live, fork).ids.size === 0, "pending", "blocks pending after Apply-all");
    if (fork && linked)
      check(render(tab) === render(fork), "tab", "Draft tab differs from the server fork");
    check(render(liveTab) === render(live), "live-tab", "Live tab differs from Live");
    // bodies beside marks: after a derivation Live holds exactly the bodies its text carries, the same as the fork's
    M.dropOrphanBodies(live);
    live.commit();
    const lc = carried(live);
    const lbod = bodies(live);
    check(
      Object.keys(lbod).every((k) => lc.has(k)) && [...lc].every((k) => lbod[k] !== undefined),
      "bodies",
      () => `Live bodies ${JSON.stringify(Object.keys(lbod))} vs marks ${JSON.stringify([...lc])}`,
    );
    if (fork && linked)
      for (const k of lc)
        check(
          M.sameValue(lbod[k], fork.getMap(M.COMMENTS).get(k)),
          "bodies",
          `body ${k} differs between Live and fork`,
        );
    // the text: no token twice; every Live token no one deleted is there
    const final = tokens(live);
    check(
      final.every((t, i) => final.indexOf(t) === i || splitMoved.has(t)),
      "duplicate-text",
      () => {
        const dup = final.filter((t, i) => final.indexOf(t) !== i && !splitMoved.has(t));
        return `doubled: ${dup.join(" ")}\n${JSON.parse(render(live))
          .filter((b) => dup.some((t) => b.includes(t)))
          .map((b) => `  ${b.slice(0, 300)}`)
          .join("\n")}`;
      },
    );
    const ids = [...blocksById(live).keys()];
    check(
      new Set(ids).size === ids.length && !ids.includes(null),
      "block-ids",
      "duplicate or missing block ids in Live",
    );
    checkReal(live);
    const errs = takeBindingErrors();
    check(errs.length === 0, "binding", () => errs.join("\n"));
    return { ok: true, stats, outcomes, log };
  } catch (e) {
    takeBindingErrors();
    return {
      ok: false,
      cls: e.cls ?? "throw",
      msg: e.cls
        ? e.message
        : String(e.stack ?? e)
            .split("\n")
            .slice(0, 4)
            .join("\n"),
      stats,
      outcomes,
      log,
    };
  }
}

/** Every id of the changes `ids` name. */
function resolveIds(d, ids) {
  return M.resolve(d, ids).flatMap((ch) => [...ch.ids]);
}

// --- CLI ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (k, dflt) => {
    const i = process.argv.indexOf(`--${k}`);
    return i < 0 ? dflt : (process.argv[i + 1] ?? true);
  };
  const opts = {
    approach: arg("approach", "B"),
    reshare: process.argv.includes("--reshare"),
    undo: arg("undo", "takeBack"),
    verbose: process.argv.includes("--verbose"),
  };
  if (arg("seed", null) != null) {
    const r = runScript(Number(arg("seed")), opts);
    freeAll();
    if (!opts.verbose) console.log(r.log.join("\n"));
    console.log(r.ok ? "OK" : `FAIL ${r.cls}\n${r.msg}`);
    process.exit(r.ok ? 0 : 1);
  }
  const n = Number(arg("n", 100));
  const start = Number(arg("start", 0));
  const fails = {};
  const firstSeeds = {};
  const totals = {};
  const routes = {};
  let ok = 0;
  const t0 = Date.now();
  let peakRss = 0;
  for (let s = start; s < start + n; s++) {
    const r = runScript(s, opts);
    freeAll();
    // loro-crdt frees a container handle from a FinalizationRegistry callback, which only runs when the loop yields
    await new Promise((resolve) => setImmediate(resolve));
    if (s % 100 === 0) peakRss = Math.max(peakRss, process.memoryUsage().rss);
    for (const [k, v] of Object.entries(r.stats))
      if (typeof v === "number") totals[k] = (totals[k] ?? 0) + v;
    for (const o of r.outcomes) {
      routes[o.route] ??= {
        n: 0,
        back: 0,
        withBack: 0,
        typed: 0,
        kept: 0,
        ok: 0,
        okLiveSince: 0,
        nLiveSince: 0,
      };
      const x = routes[o.route];
      x.n++;
      if (o.back != null) {
        x.back += o.back;
        x.withBack += o.back ? 1 : 0;
        x.typed += o.typed;
        x.kept += o.kept;
      }
      if (o.ok != null) {
        x.ok += o.ok ? 1 : 0;
        if (o.liveSince) {
          x.nLiveSince++;
          x.okLiveSince += o.ok ? 1 : 0;
        }
      }
    }
    if (r.ok) ok++;
    else {
      fails[r.cls] = (fails[r.cls] ?? 0) + 1;
      firstSeeds[r.cls] ??= [];
      if (firstSeeds[r.cls].length < 5) firstSeeds[r.cls].push(s);
      if (opts.verbose || fails[r.cls] === 1)
        console.log(`seed ${s} FAIL ${r.msg.split("\n")[0].slice(0, 240)}`);
    }
  }
  console.log(
    `SUMMARY ${JSON.stringify({ approach: opts.approach, reshare: opts.reshare, undo: opts.undo, binding: process.env.GATE_BINDING ?? "loro-prosemirror@0.4.4", start, n, ok, fails, firstSeeds, totals, routes, ms: Date.now() - t0, peakRssMB: Math.round(Math.max(peakRss, process.memoryUsage().rss) / 2 ** 20) })}`,
  );
}
