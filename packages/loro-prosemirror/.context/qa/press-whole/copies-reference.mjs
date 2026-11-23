// Reference for the copies rules on one Loro text doc, with no model code: what a copy writes after
// it takes ops in. The model's port lives in packages/document-model; this file states the rules small
// enough to read, and the cases beside it (copies-reference.probe.mjs) run against it.
//
// Every write here is either a delete by character id, or a put-back that names what each
// character stands for, so two copies writing the same answer end with the text once (oneCopy).
import { LoroDoc, VersionVector } from "loro-crdt";

export const T = "t";
const text = (doc) => doc.getText(T);
const note = (value) => JSON.stringify(value);
const readNote = (message) => {
  if (!message?.startsWith("{")) return {};
  try {
    return JSON.parse(message);
  } catch {
    return {};
  }
};
const key = (peer, counter) => `${counter}@${peer}`;
const parse = (id) => {
  const at = id.indexOf("@");
  return { counter: Number(id.slice(0, at)), peer: id.slice(at + 1) };
};

export const versionOf = (doc) => new Map(doc.oplogVersion().toJSON());
const frontiersOf = (doc, version) => doc.vvToFrontiers(new VersionVector(version));
const textDiff = (doc, from, to) =>
  doc.diff(from, to, false).find(([, diff]) => diff.type === "text")?.[1].diff ?? [];

/** The ids of the characters showing at `frontiers`, in order. */
export function idsAt(doc, frontiers) {
  const view = doc.fork();
  view.checkout(frontiers);
  const t = text(view);
  const out = [];
  for (let pos = 0; pos < t.length; pos++) {
    const cursor = t.getCursor(pos, 0);
    const id = cursor.pos();
    out.push(key(id.peer, id.counter));
  }
  return out;
}

/** Every change of `doc` at or after `since` (a version), with its note. */
function changesSince(doc, since = new Map()) {
  const out = [];
  for (const [peer, end] of versionOf(doc))
    for (let at = since.get(peer) ?? 0; at < end; ) {
      const change = doc.getChangeAt({ peer, counter: at });
      const to = change.counter + change.length;
      out.push({
        peer,
        from: at,
        to,
        lamport: change.lamport + at - change.counter,
        note: readNote(change.message),
      });
      at = to;
    }
  return out;
}

const spansOf = (ops) => Object.entries(ops ?? {}).flatMap(([peer, spans]) => spans.map((span) => [peer, span]));

/**
 * The ops that stand: one a take-back that stands names counts as never made (design §2). Returns
 * pieces `{peer, from, to, note}`.
 */
function standing(doc) {
  const changes = changesSince(doc).sort((a, b) => b.lamport - a.lamport || (a.peer < b.peer ? 1 : -1));
  const cancelled = new Map();
  const out = [];
  for (const change of changes) {
    const spans = (cancelled.get(change.peer) ?? [])
      .filter(([start, end]) => end > change.from && start < change.to)
      .sort((a, b) => a[0] - b[0]);
    let at = change.from;
    let stood = false;
    const piece = (start, end) => {
      if (start >= end) return;
      out.push({ ...change, from: start, to: end });
      stood = true;
    };
    for (const [start, end] of spans) {
      piece(at, start);
      at = Math.max(at, end);
    }
    piece(at, change.to);
    if (!stood) continue;
    for (const [peer, span] of spansOf(change.note.undo?.ops)) {
      const list = cancelled.get(peer);
      if (list) list.push(span);
      else cancelled.set(peer, [span]);
    }
  }
  return out;
}

/** Each op of `doc` in `[from, to)` of `peer`, as inserted ids or deleted ids. */
function opsIn(doc, peer, from, to) {
  const out = [];
  if (to <= from) return out;
  for (const change of doc.exportJsonInIdSpan({ peer, counter: from, length: to - from }))
    for (const op of change.ops) {
      const { content } = op;
      if (content.type === "insert" && typeof content.text === "string") {
        const length = [...content.text].length;
        out.push({
          peer,
          from: op.counter,
          to: op.counter + length,
          inserted: Array.from({ length }, (_, i) => key(peer, op.counter + i)),
        });
      } else if (content.type === "delete") {
        // `start_id` is the lowest id the op deletes, whatever the sign of `len` (a Backspace run
        // has a negative one): it covers start_id .. start_id + |len| - 1.
        const first = parse(content.start_id);
        const n = Math.abs(content.len);
        out.push({
          peer,
          from: op.counter,
          to: op.counter + n,
          deleted: Array.from({ length: n }, (_, i) => key(first.peer, first.counter + i)),
        });
      }
    }
  return out;
}

/**
 * What each character a noted commit put in stands for: `id -> original id`. `when`, if given,
 * takes each such character's Lamport time.
 */
function standsFor(doc, when) {
  const out = new Map();
  for (const change of changesSince(doc)) {
    const runs = change.note.undo?.for ?? change.note.copy?.for;
    if (!runs) continue;
    const originals = runs.flatMap(([peer, counter, length]) =>
      Array.from({ length }, (_, i) => key(peer, counter + i)),
    );
    let n = 0;
    for (const op of opsIn(doc, change.peer, change.from, change.to))
      for (const [i, id] of (op.inserted ?? []).entries())
        if (n < originals.length) {
          out.set(id, originals[n++]);
          when?.set(id, change.lamport + op.from + i - change.from);
        }
  }
  return out;
}

/** The character `id` stands for at the end of its chain (itself if it is no copy), and the chain. */
function chainOf(links, id) {
  const chain = [];
  for (let at = links.get(id); at && !chain.includes(at); at = links.get(at)) chain.push(at);
  return chain;
}

/**
 * Rules 1 and 3, which every copy runs on a text doc after ops came in. A character that stands
 * for another goes when a delete of any character on its chain stands (rule 1: the delete follows
 * the copy); and of the characters showing that stand for one original, the original stays if it
 * shows, else the latest copy (rule 3). The latest, because rule 1 may have taken an older copy
 * out on another copy of the doc while its delete stood, and the Undo of that delete wrote a
 * newer one: keeping the older would leave none once the two copies meet. Deletes by id only.
 * Returns how many went.
 */
export function oneCopy(doc) {
  const when = new Map();
  const links = standsFor(doc, when);
  // A total order every copy agrees on: by Lamport time, then by peer.
  const later = (a, b) =>
    when.get(a) !== when.get(b) ? when.get(a) > when.get(b) : BigInt(parse(a).peer) > BigInt(parse(b).peer);
  if (links.size === 0) return 0;
  const deleted = new Set();
  for (const piece of standing(doc))
    for (const op of opsIn(doc, piece.peer, piece.from, piece.to))
      for (const id of op.deleted ?? []) deleted.add(id);
  const shown = idsAt(doc, doc.frontiers());
  const showing = new Set(shown);
  const go = new Set();
  const byRoot = new Map();
  for (const id of shown) {
    const chain = chainOf(links, id);
    if (chain.length === 0) continue;
    if (chain.some((was) => deleted.has(was))) {
      go.add(id);
      continue;
    }
    const root = chain.at(-1);
    const list = byRoot.get(root);
    if (list) list.push(id);
    else byRoot.set(root, [id]);
  }
  for (const [root, copies] of byRoot) {
    const keep = showing.has(root) ? root : copies.reduce((a, b) => (later(a, b) ? a : b));
    for (const id of copies) if (id !== keep) go.add(id);
  }
  if (go.size === 0) return 0;
  if (process.env.COPIES_TRACE) {
    for (const piece of standing(doc))
      for (const op of opsIn(doc, piece.peer, piece.from, piece.to))
        for (const id of op.deleted ?? [])
          if ([...go].some((gone) => chainOf(links, gone).includes(id)))
            console.log(`  standing delete of ${id} by ${piece.peer}:${op.from} (change ${piece.from}-${piece.to}, lamport ${piece.lamport})`);
  }
  if (process.env.COPIES_TRACE)
    console.log(
      "  oneCopy takes out",
      [...go].map((id) => `${id}<-${chainOf(links, id).join("<-")}${chainOf(links, id).some((was) => deleted.has(was)) ? " (deleted)" : " (twice)"}`).join(", "),
    );
  const t = text(doc);
  for (let pos = shown.length - 1; pos >= 0; pos--) if (go.has(shown[pos])) t.delete(pos, 1);
  doc.commit();
  return go.size;
}

const minVersion = (a, b) => {
  const out = new Map();
  for (const [peer, counter] of a) {
    const other = b.get(peer) ?? 0;
    if (Math.min(counter, other) > 0) out.set(peer, Math.min(counter, other));
  }
  return out;
};

/** The hunks of a delta over a text: each maximal run of deletes and inserts, by position. */
function hunksOf(delta) {
  const out = [];
  let before = 0;
  let after = 0;
  let open = null;
  for (const op of delta) {
    if (op.retain != null) {
      before += op.retain;
      after += op.retain;
      open = null;
      continue;
    }
    if (!open) {
      open = { at: before, deleted: 0, to: after, inserted: 0 };
      out.push(open);
    }
    if (op.delete != null) {
      open.deleted += op.delete;
      before += op.delete;
    } else {
      open.inserted += op.insert.length;
      after += op.insert.length;
    }
  }
  return out;
}

/**
 * Bring a draft's fork doc up to Live's, then answer (rule 4, then `oneCopy`).
 *
 * Rule 4: where Live replaced characters the draft's pending change deleted, Live's replacement is
 * taken back whole in the fork. Live's change since the fork last had it is read as hunks over the
 * Live text the fork had. A hunk that put text in clashes when it deleted a character the draft's
 * pending change deleted, put its text strictly inside a stretch the draft deleted, or stands
 * beside Live text an earlier answer kept out (typing that goes on). For a clashing hunk the fork
 * deletes the text Live put in and puts back what Live deleted that the fork still showed, in one
 * commit that names those Live ops as taken back and what each put-back character stands for.
 */
export function forward(fork, live, stats = {}) {
  const had = minVersion(versionOf(fork), versionOf(live));
  const before = fork.frontiers();
  fork.import(live.export({ mode: "update", from: fork.oplogVersion() }));
  const after = fork.frontiers();
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const liveWas = frontiersOf(fork, had);
  const liveNow = live.frontiers();

  const wasIds = idsAt(fork, liveWas);
  const nowIds = idsAt(fork, liveNow);
  // Characters of the Live text the fork had that its pending change deleted. One the fork shows
  // a copy of (a Discard or an Undo put it back) is not deleted: the copy is that character.
  const links = standsFor(fork);
  const rootOf = (id) => chainOf(links, id).at(-1) ?? id;
  const shownRoots = new Set(idsAt(fork, before).map(rootOf));
  const draftDeleted = new Set();
  for (const hunk of hunksOf(textDiff(fork, liveWas, before)))
    for (let i = 0; i < hunk.deleted; i++)
      if (!shownRoots.has(rootOf(wasIds[hunk.at + i]))) draftDeleted.add(wasIds[hunk.at + i]);
  // Live characters an earlier answer kept out of the fork, while that answer stands (a Discard
  // or an Undo that names it takes it back). Only text Live typed: typing beside text Live put
  // back (an Undo's copies) is typing beside the characters they stand for.
  const keptOut = new Set();
  for (const change of standing(fork))
    if (change.note.clash)
      for (const [peer, [from, to]] of spansOf(change.note.undo?.ops))
        for (const op of opsIn(fork, peer, from, to))
          for (const id of op.inserted ?? []) if (!links.has(id)) keptOut.add(id);

  const out = new Set();
  const back = new Set();
  for (const hunk of hunksOf(textDiff(fork, liveWas, liveNow))) {
    if (hunk.inserted === 0) continue;
    const removed = wasIds.slice(hunk.at, hunk.at + hunk.deleted);
    const left = wasIds[hunk.at - 1];
    const right = wasIds[hunk.at + hunk.deleted];
    const both = removed.some((id) => draftDeleted.has(id));
    const inside = hunk.deleted === 0 && draftDeleted.has(left) && draftDeleted.has(right);
    const goesOn = keptOut.has(left) || keptOut.has(right);
    if (!both && !inside && !goesOn) continue;
    stats.clashes = (stats.clashes ?? 0) + 1;
    for (let i = 0; i < hunk.inserted; i++) out.add(nowIds[hunk.to + i]);
    for (const id of removed) back.add(id);
  }
  if (out.size > 0 || back.size > 0) {
    // The way back from what this forward did to the fork's text, cut down to the clashing hunks.
    const wasFork = idsAt(fork, before);
    const nowFork = idsAt(fork, after);
    const delta = [];
    const put = [];
    let a = 0;
    let b = 0;
    const retain = (n) => {
      const last = delta.at(-1);
      if (last?.retain != null && !last.attributes) last.retain += n;
      else delta.push({ retain: n });
    };
    for (const op of textDiff(fork, after, before)) {
      if (op.retain != null) {
        retain(op.retain);
        a += op.retain;
        b += op.retain;
      } else if (op.delete != null) {
        for (let i = 0; i < op.delete; i++)
          if (out.has(nowFork[a + i])) delta.push({ delete: 1 });
          else retain(1);
        a += op.delete;
      } else {
        for (let i = 0; i < op.insert.length; i++) {
          if (!back.has(wasFork[b + i])) continue;
          delta.push({ insert: op.insert[i], ...(op.attributes ? { attributes: op.attributes } : {}) });
          put.push(wasFork[b + i]);
        }
        b += op.insert.length;
      }
    }
    // The Live ops of the clashing hunks, named as taken back: its inserts kept out, and the
    // deletes whose characters come back (or rule 1 would take the put-back text out again).
    const ops = {};
    for (const [peer, end] of versionOf(live)) {
      const from = had.get(peer) ?? 0;
      for (const op of opsIn(fork, peer, from, end)) {
        const named =
          (op.inserted ?? []).some((id) => out.has(id)) || (op.deleted ?? []).some((id) => back.has(id));
        if (!named) continue;
        const spans = (ops[peer] ??= []);
        const last = spans.at(-1);
        if (last && last[1] === op.from) last[1] = op.to;
        else spans.push([op.from, op.to]);
      }
    }
    if (put.length > 0) stats.putBack = (stats.putBack ?? 0) + 1;
    const runs = [];
    for (const id of put) {
      const { peer, counter } = parse(id);
      const run = runs.at(-1);
      if (run && run[0] === peer && run[1] + run[2] === counter) run[2]++;
      else runs.push([peer, counter, 1]);
    }
    const message = note({ undo: { for: runs, ops }, clash: true });
    text(fork).applyDelta(delta);
    fork.commit({ message });
  }
  oneCopy(fork);
}

/** Apply: Live takes the fork's ops in, then answers as every copy does. */
export function apply(fork, live) {
  forward(fork, live);
  const before = live.frontiers();
  live.import(fork.export({ mode: "update", from: live.oplogVersion() }));
  oneCopy(live);
  return { before, after: live.frontiers() };
}

/** The characters the write from `before` to `after` deleted, as runs, in text order. */
function deletedBetween(doc, before, after) {
  const ids = idsAt(doc, before);
  const runs = [];
  for (const hunk of hunksOf(textDiff(doc, before, after)))
    for (let i = 0; i < hunk.deleted; i++) {
      const { peer, counter } = parse(ids[hunk.at + i]);
      const run = runs.at(-1);
      if (run && run[0] === peer && run[1] + run[2] === counter) run[2]++;
      else runs.push([peer, counter, 1]);
    }
  return runs;
}

function opsBetween(doc, before, after) {
  const from = new Map(doc.frontiersToVV(before).toJSON());
  const out = {};
  for (const [peer, to] of new Map(doc.frontiersToVV(after).toJSON()))
    if (to > (from.get(peer) ?? 0)) out[peer] = [[from.get(peer) ?? 0, to]];
  return out;
}

/** Take the write `before -> after` back at the head of `doc`, which nothing wrote over since. */
export function takeBack(doc, { before, after }) {
  const message = note({ undo: { for: deletedBetween(doc, before, after), ops: opsBetween(doc, before, after) } });
  const head = doc.frontiers();
  doc.applyDiff(doc.diff(after, before, false));
  doc.commit({ message });
  return { before: head, after: doc.frontiers() };
}

/** A press's Undo: Live takes the press back, and the fork takes Live's Undo back as its own edit. */
export function undoApply(fork, live, pressed) {
  takeBack(live, pressed);
  const at = fork.frontiers();
  fork.import(live.export({ mode: "update", from: fork.oplogVersion() }));
  takeBack(fork, { before: at, after: fork.frontiers() });
  oneCopy(fork);
}

/** Discard: the fork takes Live's text as its own edit, naming the draft's ops as taken back. */
export function discard(fork, live) {
  forward(fork, live);
  const had = minVersion(versionOf(fork), versionOf(live));
  const before = fork.frontiers();
  const liveNow = live.frontiers();
  const ops = {};
  for (const [peer, to] of versionOf(fork)) if (to > (had.get(peer) ?? 0)) ops[peer] = [[had.get(peer) ?? 0, to]];
  const message = note({ undo: { for: deletedBetween(fork, liveNow, before), ops } });
  fork.applyDiff(fork.diff(before, liveNow, false));
  fork.commit({ message });
  oneCopy(fork);
}

export function docOf(peer, from) {
  const doc = from ? from.fork() : new LoroDoc();
  doc.setPeerId(BigInt(peer));
  return doc;
}

/** Replace the first `find` in `doc` with `put`, as a selection typed over (one commit). */
export function replace(doc, find, put) {
  const t = text(doc);
  const at = t.toString().indexOf(find);
  if (at < 0) throw new Error(`no "${find}" in "${t.toString()}"`);
  if (find.length > 0) t.delete(at, find.length);
  if (put.length > 0) t.insert(at, put);
  doc.commit();
}

export const read = (doc) => text(doc).toString();

/** For tracing: every change with a note, and what went in the last `oneCopy`. */
export function describe(doc) {
  return changesSince(doc)
    .filter((change) => Object.keys(change.note).length > 0)
    .sort((a, b) => a.lamport - b.lamport)
    .map((change) => `${change.peer}:${change.from}-${change.to} L${change.lamport} ${JSON.stringify(change.note)}`);
}
