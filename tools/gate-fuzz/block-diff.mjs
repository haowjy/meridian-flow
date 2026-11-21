// The block-diff model (design §2), on Loro containers only: no ProseMirror, no op ids, no mark fix-ups.
// A block is a top-level element of the root `children` list, named by its `id` attribute. A pending change
// is every diff op that touches a block id on either side: an edited block (content differs), an inserted or
// deleted one, and, when the binding re-created or swapped containers, the ids those ops share.
//
//   diffBlocks(fork, target, source)  the block changes that would make `target` equal `source`, computed in
//                                     the fork, which holds both histories after forwarding.
//   sliceBlocks(d, changes)           the Loro diff for exactly those changes, for `target.applyDiff`.
//   withdrawBlocks(fork, d, changes)  after an Apply: delete the fork's own copies of what Live just received.
//   applyBlocks / resetBlocks         the press and the Reset; Discard (B) is a Reset of every change.
//   returnToPending(fork, undoBytes)  the fork half of a press's Undo (gate d8).
import { LoroList, LoroMap, LoroText } from "loro-crdt";

const ROOT = "doc";
export const COMMENTS = "comments";

export function forward(live, fork) {
  fork.import(live.export({ mode: "update", from: fork.oplogVersion() }));
}

const rootList = (doc) => doc.getMap(ROOT).get("children");
const idOf = (c) => (c instanceof LoroMap ? (c.get("attributes")?.get("id") ?? null) : null);

/** The comment keys a block's text carries. */
function commentKeys(c, out = new Set()) {
  if (c instanceof LoroText) {
    for (const span of c.toDelta())
      for (const k of Object.keys(span.attributes ?? {}))
        if (k.startsWith("comment_")) out.add(k.slice(8));
  } else if (c instanceof LoroMap) {
    // the binding fork keeps an inline node's marks in a `marks` map beside `attributes`
    for (const k of c.get("marks")?.keys() ?? []) if (k.startsWith("comment_")) out.add(k.slice(8));
    const kids = c.get("children");
    if (kids) for (const k of kids.toArray()) commentKeys(k, out);
  }
  return out;
}

const sorted = (v) =>
  v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, sorted(v[k])]),
      )
    : v;
export const sameValue = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** A block's content as a plain value: node name, attributes, children, text with its marks; plus the bodies it carries. */
function contentOf(c) {
  if (c instanceof LoroText) return c.toDelta();
  // an empty text is no content: the binding writes an empty block either way
  const kids = (c.get("children")?.toArray() ?? []).filter(
    (k) => !(k instanceof LoroText && k.length === 0),
  );
  const value = {
    n: c.get("nodeName"),
    a: c.get("attributes")?.toJSON() ?? {},
    c: kids.map(contentOf),
  };
  const marks = c.get("marks")?.toJSON();
  if (marks && Object.keys(marks).length) value.m = marks;
  return value;
}
export function blockValue(doc, c) {
  const bodies = {};
  for (const k of [...commentKeys(c)].sort())
    bodies[k] = sorted(doc.getMap(COMMENTS).get(k) ?? null);
  return JSON.stringify([contentOf(c), bodies]);
}

/**
 * The block changes `source - target`. Ops: `keep` (one container on both sides), `del` (a target block the
 * source lacks), `ins` (a source block the target lacks). A del and an ins of one id with equal content in one
 * run between keeps are a restored copy, not a change (q9 at block level).
 */
export function diffBlocks(fork, target, source) {
  const entries = fork.diff(target.frontiers(), source.frontiers(), false);
  const tList = rootList(target).toArray();
  const sList = rootList(source).toArray();
  const rootId = rootList(fork).id;
  const listEntry = entries.find(([cid]) => cid === rootId);
  const ops = [];
  let ti = 0;
  let si = 0;
  for (const d of listEntry?.[1].diff ?? []) {
    if (d.retain != null)
      for (let i = 0; i < d.retain; i++) ops.push({ kind: "keep", t: tList[ti++], s: sList[si++] });
    else if (d.delete != null)
      for (let i = 0; i < d.delete; i++) ops.push({ kind: "del", t: tList[ti++] });
    else for (const value of d.insert) ops.push({ kind: "ins", s: sList[si++], value });
  }
  while (ti < tList.length) ops.push({ kind: "keep", t: tList[ti++], s: sList[si++] }); // Loro omits the trailing retain

  // Which top-level block each nested diff entry belongs to (parent chains hold for deleted containers too).
  const topOf = new Map();
  const top = (cid) => {
    if (topOf.has(cid)) return topOf.get(cid);
    let c = fork.getContainerById(cid);
    let p = c?.parent();
    while (p && p.id !== rootId) {
      c = p;
      p = c.parent();
    }
    const t = p ? c.id : null;
    topOf.set(cid, t);
    return t;
  };
  const commentsId = fork.getMap(COMMENTS).id;
  const bodiesChanged = entries.some(([cid]) => cid === commentsId);
  const touched = new Set();
  for (const [cid] of entries) if (cid !== rootId && cid !== commentsId) touched.add(top(cid));

  // Changed keeps; restored copies dropped.
  for (const op of ops) {
    if (op.kind === "keep" && op.t.id !== op.s.id)
      throw new Error(`root retain pairs two containers: ${op.t.id} ${op.s.id}`);
    if (op.kind === "keep")
      op.changed =
        (bodiesChanged || touched.has(op.t.id)) &&
        blockValue(target, op.t) !== blockValue(source, op.s);
  }
  // In one run between keeps, the dels and inss that match in order (same id, same content) are restored copies.
  let run = [];
  const pairRun = () => {
    const dels = run.filter((o) => o.kind === "del");
    const inss = run.filter((o) => o.kind === "ins");
    run = [];
    if (!dels.length || !inss.length) return;
    const same = (a, b) =>
      idOf(a.t) === idOf(b.s) && blockValue(target, a.t) === blockValue(source, b.s);
    const L = dels.map(() => new Array(inss.length + 1).fill(0));
    L.push(new Array(inss.length + 1).fill(0));
    for (let i = dels.length - 1; i >= 0; i--)
      for (let j = inss.length - 1; j >= 0; j--)
        L[i][j] = same(dels[i], inss[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    for (let i = 0, j = 0; i < dels.length && j < inss.length; ) {
      if (same(dels[i], inss[j])) {
        inss[j].pair = dels[i];
        dels[i++].paired = inss[j++].paired = true;
      } else if (L[i + 1][j] >= L[i][j + 1]) i++;
      else j++;
    }
  };
  for (const op of ops)
    if (op.kind === "keep") pairRun();
    else run.push(op);
  pairRun();

  // A change is the set of ids its ops share (union-find over ids on both sides).
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  const add = (x) => (parent.has(x) ? x : (parent.set(x, x), x));
  const live = ops.filter((o) => (o.kind === "keep" ? o.changed : !o.paired));
  for (const op of live) {
    const ids = [op.t && (idOf(op.t) ?? op.t.id), op.s && (idOf(op.s) ?? op.s.id)]
      .filter(Boolean)
      .map(add);
    for (const id of ids.slice(1)) parent.set(find(id), find(ids[0]));
  }
  // Content-equal ops: restored copies and touched blocks whose content did not change (variant: reshare).
  const copies = ops.filter(
    (o) => o.paired || (o.kind === "keep" && !o.changed && touched.has(o.t.id)),
  );
  const changes = new Map();
  for (const op of live) {
    const key = find(op.t ? (idOf(op.t) ?? op.t.id) : (idOf(op.s) ?? op.s.id));
    if (!changes.has(key)) changes.set(key, { ids: new Set(), ops: [] });
    changes.get(key).ops.push(op);
  }
  for (const [x] of parent) changes.get(find(x))?.ids.add(x);
  if (process.env.DBG)
    console.log(
      "  ids T:",
      tList.map((c) => `${idOf(c)}@${c.id}`).join(" "),
      "\n  ids S:",
      sList.map((c) => `${idOf(c)}@${c.id}`).join(" "),
    );
  if (process.env.DBG)
    console.log(
      "  ops:",
      ops
        .map((o) => `${o.kind}:${idOf(o.t ?? o.s)}${o.changed ? "*" : ""}${o.paired ? "~" : ""}`)
        .join(" "),
    );
  return {
    entries,
    ops,
    topOf: top,
    rootId,
    commentsId,
    changes: [...changes.values()],
    copies,
    target,
    source,
  };
}

/** The pending changes of a draft's document: `diffBlocks(fork, live, fork)`, after forwarding. */
export function changedBlocks(live, fork) {
  forward(live, fork);
  return diffBlocks(fork, live, fork);
}

/** The changes that name any of `blockIds`. */
export function resolve(d, blockIds) {
  const want = new Set(blockIds);
  return d.changes.filter((ch) => [...ch.ids].some((id) => want.has(id)));
}

/** The diff for exactly `chosen`: the root list with only their inserts and deletes, and their blocks' nested entries. */
export function sliceBlocks(d, chosen) {
  const on = new Set(chosen.flatMap((ch) => ch.ops));
  const rootOps = [];
  let retain = 0;
  const flush = () => {
    if (retain) rootOps.push({ retain });
    retain = 0;
  };
  const del = () => (flush(), rootOps.push({ delete: 1 }));
  const ins = (value) => (flush(), rootOps.push({ insert: [value] }));
  // A run between keeps is walked in the source's order: a restored copy (paired) holds its target element's place.
  let run = [];
  const emitRun = () => {
    const T = run.filter((o) => o.kind === "del");
    let ti = 0;
    const upTo = (t) => {
      while (ti < T.length && T[ti] !== t) on.has(T[ti++]) ? del() : retain++;
    };
    for (const o of run.filter((x) => x.kind === "ins")) {
      if (o.paired && !on.has(o)) {
        upTo(o.pair);
        ti++;
        retain++;
      } else if (on.has(o)) ins(o.value);
    }
    upTo(null);
    run = [];
  };
  for (const op of d.ops) {
    if (op.kind === "keep") {
      emitRun();
      retain++;
    } else run.push(op);
  }
  emitRun();
  const blocks = new Set([...on].map((op) => op.s?.id).filter(Boolean));
  const out = [];
  for (const [cid, diff] of d.entries) {
    if (cid === d.rootId) {
      if (rootOps.length) out.push([cid, { type: "list", diff: rootOps }]);
    } else if (cid !== d.commentsId && blocks.has(d.topOf(cid))) out.push([cid, diff]);
  }
  return out;
}

/** Copy the comment bodies the chosen source blocks carry into the target; drop bodies no text carries. */
function copyBodies(d, chosen) {
  const from = d.source.getMap(COMMENTS);
  const into = d.target.getMap(COMMENTS);
  for (const op of chosen.flatMap((ch) => ch.ops))
    if (op.s)
      for (const k of commentKeys(op.s)) {
        const body = from.get(k);
        if (!sameValue(body, into.get(k))) into.set(k, body);
      }
}
export function dropOrphanBodies(doc) {
  const carried = new Set();
  for (const b of rootList(doc).toArray()) commentKeys(b, carried);
  const map = doc.getMap(COMMENTS);
  for (const k of map.keys()) if (!carried.has(k)) map.delete(k);
}

/** After an Apply, delete the fork's own inserted blocks, list elements and text runs of the chosen changes. */
export function withdrawBlocks(fork, d, chosen) {
  const on = new Set(chosen.flatMap((ch) => ch.ops));
  const blocks = new Set([...on].map((op) => op.s?.id).filter(Boolean));
  const cuts = [];
  // Root list: the chosen inserted blocks, at their fork index.
  let si = 0;
  for (const op of d.ops) {
    if (op.kind === "del") continue;
    if (op.kind === "ins" && on.has(op)) cuts.push([d.rootId, si, 1]);
    si++;
  }
  // Inside a chosen block: every inserted run and list element, at its fork position.
  for (const [cid, diff] of d.entries) {
    if (cid === d.rootId || cid === d.commentsId || !blocks.has(d.topOf(cid))) continue;
    if (diff.type !== "text" && diff.type !== "list") continue;
    let pos = 0;
    for (const o of diff.diff) {
      if (o.retain != null) pos += o.retain;
      else if (o.insert != null) {
        cuts.push([cid, pos, o.insert.length]);
        pos += o.insert.length;
      }
    }
  }
  // inner containers first, later positions first
  const depth = (cid) => {
    let n = 0;
    for (let c = fork.getContainerById(cid); c; c = c.parent()) n++;
    return n;
  };
  cuts.sort((a, b) => depth(b[0]) - depth(a[0]) || (a[0] === b[0] ? b[1] - a[1] : 0));
  for (const [cid, at, n] of cuts) {
    const c = fork.getContainerById(cid);
    if (!c.isDeleted()) c.delete(at, n);
  }
}

/** The press's text half for one document. Returns what an Undo needs. */
export function applyBlocks(live, fork, blockIds, message) {
  forward(live, fork);
  const d = diffBlocks(fork, live, fork);
  const chosen = blockIds === "all" ? d.changes : resolve(d, blockIds);
  if (!chosen.length) return { chosen, noop: true };
  const before = live.frontiers();
  live.applyDiff(sliceBlocks(d, chosen));
  copyBodies(d, chosen);
  dropOrphanBodies(live);
  live.commit({ message });
  const after = live.frontiers();
  withdrawBlocks(fork, d, chosen);
  fork.commit({ message });
  forward(live, fork);
  return { chosen, before, after };
}

/**
 * Variant `reshare`: a block whose fork copy differs from Live only in identity (a restored copy, or text the
 * fork deleted and gave back) is applied silently, so Live and the fork share its containers again and Live's
 * later typing in it reaches the fork. Live's content does not change.
 */
export function reshare(live, fork, message = "reshare") {
  forward(live, fork);
  const d = diffBlocks(fork, live, fork);
  if (!d.copies.length) return 0;
  const chosen = [{ ids: new Set(), ops: d.copies }];
  live.applyDiff(sliceBlocks(d, chosen));
  live.commit({ message });
  withdrawBlocks(fork, d, chosen);
  fork.commit({ message });
  forward(live, fork);
  return d.copies.length;
}

/** Single-block Reset in the fork (and Discard B: every change): the fork takes Live's block back. */
export function resetBlocks(live, fork, blockIds, message) {
  forward(live, fork);
  const d = diffBlocks(fork, fork, live);
  const chosen = blockIds === "all" ? d.changes : resolve(d, blockIds);
  if (!chosen.length) return { chosen, noop: true };
  const before = fork.frontiers();
  fork.applyDiff(sliceBlocks(d, chosen));
  copyBodies(d, chosen);
  dropOrphanBodies(fork);
  fork.commit({ message });
  return { chosen, before, after: fork.frontiers() };
}

/** The fork half of a press's Undo: import the Undo's update alone and invert it in the fork's own coordinates. */
export function returnToPending(fork, undoBytes, message) {
  const b0 = fork.frontiers();
  fork.import(undoBytes);
  const b1 = fork.frontiers();
  fork.applyDiff(fork.diff(b1, b0, false));
  fork.commit({ message });
}

/**
 * Variant `--undo inverse`: one commit's inverse, written at the commit's own frontier and merged in, so what was
 * typed since stays (the way an AI write is planned on its read frontier, design §5). Returns the update.
 */
export function invertCommit(doc, before, after, peer, message) {
  const at = doc.forkAt(after);
  at.setPeerId(peer);
  at.applyDiff(at.diff(after, before, false));
  at.commit({ message });
  const bytes = at.export({ mode: "update", from: doc.oplogVersion() });
  at.free();
  doc.import(bytes);
  return bytes;
}

/** Restore before, as design §5 writes it: `fork.diff(now, beforeTurn)` applied to the fork. */
export function restoreBeforeAsWritten(fork, beforeTurn, message) {
  fork.applyDiff(fork.diff(fork.frontiers(), beforeTurn, false));
  fork.commit({ message });
}

/** Restore before on today's Live: back to the fork's own state at the turn's start, with every Live op kept. */
export function restoreBeforeOnLive(live, fork, beforeTurn, message) {
  forward(live, fork);
  const vv = fork.frontiersToVV(beforeTurn).toJSON();
  for (const [peer, n] of live.oplogVersion().toJSON())
    if ((vv.get(peer) ?? 0) < n) vv.set(peer, n);
  const target = fork.vvToFrontiers(vvFrom(fork, vv));
  fork.applyDiff(fork.diff(fork.frontiers(), target, false));
  fork.commit({ message });
}
let VV;
function vvFrom(fork, map) {
  VV ??= fork.oplogVersion().constructor;
  return new VV(map);
}

export { LoroList, LoroText };
