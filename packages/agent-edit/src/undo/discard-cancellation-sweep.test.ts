/** Cold real-Yjs model-A subset of the v2 sweep, with all rejected controls. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  decodeUpdateForDependencies,
  deleteRanges,
  rangeCovers,
  structDependencies,
  suppliedRanges,
} from "../integration.js";

const ROOT = "prosemirror";
type Status = "active" | "discarded" | "pushed";
type Row = {
  id: number;
  status: Status;
  kind: "write" | "restoration";
  restores: number[];
  actor: string;
  para: number[];
  update: Uint8Array;
  inLive: boolean;
};
type Model = "A" | "B" | "A_oneWay" | "A_noCarry" | "A_restorationJoins";
const copies = (m: Model) => m !== "B";
type World = {
  model: Model;
  live: Y.Doc;
  draft: Y.Doc;
  rows: Row[];
  generation: number;
  oracle: { live: string[]; pend: (string | null)[] };
};
let nextClient = 10000;
const para = (s: string) => {
  const p = new Y.XmlElement("paragraph"),
    t = new Y.XmlText();
  t.insert(0, s);
  p.insert(0, [t]);
  return p;
};
const texts = (d: Y.Doc) =>
  (d.getXmlFragment(ROOT).toArray() as Y.XmlElement[]).map((p) =>
    (p.get(0) as Y.XmlText).toString(),
  );
const xt = (d: Y.Doc, p: number) =>
  (d.getXmlFragment(ROOT).get(p) as Y.XmlElement).get(0) as Y.XmlText;
const fresh = () => new Y.Doc({ gc: false });
const clone = (d: Y.Doc) => {
  const c = fresh();
  Y.applyUpdate(c, Y.encodeStateAsUpdate(d));
  return c;
};
const sync = (from: Y.Doc, to: Y.Doc) =>
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
function integrated(doc: Y.Doc, updates: readonly Uint8Array[]): boolean {
  const sv = Y.decodeStateVector(Y.encodeStateVector(doc)),
    deleted = deleteRanges(decodeUpdateForDependencies(Y.encodeStateAsUpdate(doc)));
  return updates.every((update) => {
    const decoded = decodeUpdateForDependencies(update);
    return (
      suppliedRanges(decoded).every(
        (range) => (sv.get(range.client) ?? 0) >= range.clock + range.length,
      ) &&
      deleteRanges(decoded).every((range) =>
        deleted.some((existing) => rangeCovers(existing, range)),
      )
    );
  });
}
type Range = { client: number; clock: number; len: number };
const insR = (u: Uint8Array): Range[] =>
  suppliedRanges(decodeUpdateForDependencies(u)).map((r) => ({
    client: r.client,
    clock: r.clock,
    len: r.length,
  }));
const delR = (u: Uint8Array): Range[] =>
  deleteRanges(decodeUpdateForDependencies(u)).map((r) => ({
    client: r.client,
    clock: r.clock,
    len: r.length,
  }));
const inR = (rs: Range[], id: { client: number; clock: number }) =>
  rs.some((r) => r.client === id.client && id.clock >= r.clock && id.clock < r.clock + r.len);
const refs = (u: Uint8Array) => structDependencies(decodeUpdateForDependencies(u));
const delIds = (u: Uint8Array) =>
  delR(u).flatMap((r) =>
    Array.from({ length: r.len }, (_, i) => ({ client: r.client, clock: r.clock + i })),
  );
const hasId = (d: Y.Doc, id: { client: number; clock: number }) =>
  (Y.decodeStateVector(Y.encodeStateVector(d)).get(id.client) ?? 0) > id.clock;
const cold = (w: World) => {
  const next = clone(w.draft);
  w.draft.destroy();
  w.draft = next;
};
/** Canonical dependency predicate between rows (later b on earlier a). */
function dependsOn(b: Row, a: Row) {
  const ai = insR(a.update),
    ad = delR(a.update);
  if (refs(b.update).some((r) => inR(ai, r) || inR(ad, r))) return true;
  if (delIds(b.update).some((i) => inR(ai, i))) return true;
  return false;
}
// ---- world
function world(model: Model): World {
  const live = fresh();
  live.clientID = 2000;
  live.getXmlFragment(ROOT).insert(0, [para("the red fox"), para("blue sky"), para("green hill")]);
  return {
    model,
    live,
    draft: clone(live),
    rows: [],
    generation: 1,
    oracle: { live: texts(live), pend: [null, null, null] },
  };
}
function capture(d: Y.Doc, fn: () => void) {
  d.clientID = nextClient++;
  const us: Uint8Array[] = [];
  const cb = (u: Uint8Array) => us.push(u);
  d.on("update", cb);
  d.transact(fn);
  d.off("update", cb);
  return us.length ? Y.mergeUpdates(us) : null;
}
type Staged = {
  generation: number;
  update: Uint8Array;
  p: number;
  op: TextOp;
  actor: string;
} | null;
/** Stage a model write on a thread-peer fork of the draft; nothing reaches the branch yet. */
function stage(w: World, p: number, op: TextOp): Staged {
  const fork = clone(w.draft);
  const cur = texts(fork)[p],
    o = op(cur);
  if (o.at < 0) {
    fork.destroy();
    return null;
  }
  const u = capture(fork, () => {
    const t = xt(fork, p);
    if (o.del) t.delete(o.at, o.del);
    if (o.ins) t.insert(o.at, o.ins);
  });
  fork.destroy();
  return u ? { generation: w.generation, update: u, p, op, actor: "model" } : null;
}
/** Save a staged write. A: commits as today. B: production guard rejects a stale generation. */
function save(w: World, st: Staged) {
  if (!st) return;
  if (st.generation !== w.generation) {
    if (w.model === "B") throw Error("BranchStaleUpdateError");
  }
  const probe = clone(w.draft);
  Y.applyUpdate(probe, st.update);
  if (!integrated(probe, [st.update])) {
    throw Error("staged write left pending structs");
  }
  probe.destroy();
  Y.applyUpdate(w.draft, st.update);
  w.rows.push({
    id: w.rows.length + 1,
    status: "active",
    kind: "write",
    restores: [],
    actor: st.actor,
    para: [st.p],
    update: st.update,
    inLive: false,
  });
  w.oracle.pend[st.p] = apply(
    w.oracle.pend[st.p] ?? w.oracle.live[st.p],
    st.op(w.oracle.pend[st.p] ?? w.oracle.live[st.p]),
  );
}
type TextOp = (s: string) => { at: number; del: number; ins: string };
const apply = (s: string, o: { at: number; del: number; ins: string }) =>
  s.slice(0, o.at) + o.ins + s.slice(o.at + o.del);
/** One pending edit (one row per paragraph part). */
function edit(w: World, actor: string, parts: { p: number; op: TextOp }[]) {
  for (const { p, op } of parts) {
    const cur = texts(w.draft)[p],
      o = op(cur);
    if (o.at < 0) throw Error(`op target missing in "${cur}"`);
    const u = capture(w.draft, () => {
      const t = xt(w.draft, p);
      if (o.del) t.delete(o.at, o.del);
      if (o.ins) t.insert(o.at, o.ins);
    });
    if (u)
      w.rows.push({
        id: w.rows.length + 1,
        status: "active",
        kind: "write",
        restores: [],
        actor,
        para: [p],
        update: u,
        inLive: false,
      });
    w.oracle.pend[p] = apply(w.oracle.pend[p] ?? w.oracle.live[p], o);
  }
}
/** Classes: connected components of active write rows under the predicate (restoration rows never merge). */
function classes(w: World) {
  const act = w.rows.filter(
    (r) => r.status === "active" && (r.kind === "write" || w.model === "A_restorationJoins"),
  );
  const parent = new Map(act.map((r) => [r.id, r.id]));
  const find = (x: number): number => {
    const next = parent.get(x);
    if (next === undefined) throw new Error("Missing review row");
    return next === x ? x : find(next);
  };
  for (let i = 0; i < act.length; i++)
    for (let j = i + 1; j < act.length; j++)
      if (dependsOn(act[j], act[i])) parent.set(find(act[j].id), find(act[i].id));
  const groups = new Map<number, Row[]>();
  for (const r of act) {
    const k = find(r.id);
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  return [...groups.values()];
}
const classesOf = (w: World, p: number) =>
  classes(w).filter((c) => c.some((r) => r.para.includes(p) && r.kind === "write"));
function pull(w: World) {
  sync(w.live, w.draft);
}
// ---- Discard
function discard(w: World, cls: Row[]) {
  const ids = new Set(cls.map((r) => r.id));
  if (copies(w.model)) {
    const peer = clone(w.live);
    const T = Symbol("t"),
      O = Symbol("o");
    const um = new Y.UndoManager(peer.getXmlFragment(ROOT), {
      trackedOrigins: new Set([T]),
      captureTimeout: Infinity,
    });
    um.stopCapturing();
    for (const r of w.rows) Y.applyUpdate(peer, r.update, ids.has(r.id) ? T : O);
    if (
      !integrated(
        peer,
        w.rows.map((r) => r.update),
      )
    )
      throw Error("discard peer pending");
    um.stopCapturing();
    peer.clientID = nextClient++;
    const us: Uint8Array[] = [];
    const cb = (u: Uint8Array) => us.push(u);
    peer.on("update", cb);
    while (um.undoStack.length) um.undo();
    peer.off("update", cb);
    um.destroy();
    sync(peer, w.draft);
    peer.destroy();
    for (const r of cls) r.status = "discarded";
    if (us.length)
      w.rows.push({
        id: w.rows.length + 1,
        status: "active",
        kind: "restoration",
        restores: [...ids],
        actor: "discard",
        para: [...new Set(cls.flatMap((r) => r.para))],
        update: Y.mergeUpdates(us),
        inLive: false,
      });
  } else {
    for (const r of cls) r.status = "discarded";
    const d = clone(w.live);
    for (const r of w.rows) if (r.status !== "discarded") Y.applyUpdate(d, r.update);
    if (
      !integrated(
        d,
        w.rows.filter((r) => r.status !== "discarded").map((r) => r.update),
      )
    )
      throw Error("re-fork pending");
    w.draft.destroy();
    w.draft = d;
    w.generation++;
  }
  for (const p of new Set(cls.flatMap((r) => r.para))) w.oracle.pend[p] = null;
}
// ---- Selective Apply
function carry(w: World, cls: Row[]) {
  const chosen = new Map(cls.map((r) => [r.id, r]));
  if (w.model === "B" || w.model === "A_noCarry" || w.model === "A_restorationJoins")
    return [...chosen.values()].sort((a, b) => a.id - b.id);
  let again = true;
  const add = (r: Row) => {
    if (!chosen.has(r.id) && !r.inLive) {
      chosen.set(r.id, r);
      again = true;
    }
  };
  while (again) {
    again = false;
    const cur = [...chosen.values()];
    // structural suppliers: ids the published rows reference or delete that live lacks
    for (const r of cur)
      for (const id of [...refs(r.update), ...delIds(r.update)]) {
        if (hasId(w.live, id) || cur.some((c) => inR(insR(c.update), id))) continue;
        const s = w.rows.find((h) => inR(insR(h.update), id));
        if (!s) throw Error("unsupplied");
        add(s);
      }
    for (const r of cur) {
      if (r.status === "discarded")
        for (const h of w.rows) if (h.kind === "restoration" && h.restores.includes(r.id)) add(h); // discarded row -> its cancellation
      if (r.kind === "restoration" && w.model !== "A_oneWay")
        for (const id of r.restores) {
          const row = w.rows.find((h) => h.id === id);
          if (!row) throw new Error("Missing cancelled row");
          add(row);
        } // cancellation -> what it cancelled
    }
  }
  return [...chosen.values()].sort((a, b) => a.id - b.id);
}
function applySelected(w: World, cls: Row[]) {
  const rows = carry(w, cls);
  const after = clone(w.live);
  for (const r of rows) Y.applyUpdate(after, r.update);
  if (
    !integrated(
      after,
      rows.map((r) => r.update),
    )
  )
    throw Error("BranchPeerIntegrationError");
  sync(after, w.live);
  after.destroy();
  for (const r of rows) {
    r.inLive = true;
    if (r.status === "active") r.status = "pushed";
  }
  for (const p of new Set(cls.flatMap((r) => r.para))) {
    if (w.oracle.pend[p] !== null) {
      w.oracle.live[p] = w.oracle.pend[p] ?? w.oracle.live[p];
      w.oracle.pend[p] = null;
    }
  }
  pull(w);
}
function applyWhole(w: World) {
  sync(w.draft, w.live);
  for (const r of w.rows) {
    r.inLive = true;
    if (r.status === "active") r.status = "pushed";
  }
  for (let p = 0; p < 3; p++)
    if (w.oracle.pend[p] !== null) {
      w.oracle.live[p] = w.oracle.pend[p] ?? w.oracle.live[p];
      w.oracle.pend[p] = null;
    }
  pull(w);
}
// ---- text ops
const word =
  (wd: string, by: string): TextOp =>
  (s) => ({ at: s.indexOf(wd), del: wd.length, ins: by });
const inside =
  (wd: string, x: string): TextOp =>
  (s) => ({ at: s.indexOf(wd) < 0 ? -1 : s.indexOf(wd) + 1, del: 0, ins: x });
const before =
  (wd: string, x: string): TextOp =>
  (s) => ({ at: s.indexOf(wd), del: 0, ins: x });
const after =
  (wd: string, x: string): TextOp =>
  (s) => ({ at: s.indexOf(wd) < 0 ? -1 : s.indexOf(wd) + wd.length, del: 0, ins: x });
// ---- generator
type Step = { name: string; run: (w: World) => void };
const first: Step[] = [];
for (const actor of ["model", "writer"]) {
  first.push({
    name: `${actor}:replace red>gold`,
    run: (w) => edit(w, actor, [{ p: 0, op: word("red", "gold") }]),
  });
  first.push({
    name: `${actor}:delete red`,
    run: (w) => edit(w, actor, [{ p: 0, op: word("red ", "") }]),
  });
  first.push({
    name: `${actor}:insert inside red`,
    run: (w) => edit(w, actor, [{ p: 0, op: inside("red", "Q") }]),
  });
  first.push({
    name: `${actor}:two-part replace (red>gold, green>lime)`,
    run: (w) =>
      edit(w, actor, [
        { p: 0, op: word("red", "gold") },
        { p: 2, op: word("green", "lime") },
      ]),
  });
  first.push({
    name: `${actor}:two-part delete (red, green)`,
    run: (w) =>
      edit(w, actor, [
        { p: 0, op: word("red ", "") },
        { p: 2, op: word("green ", "") },
      ]),
  });
}
const onRestored: Step[] = [{ name: "none", run: () => {} }];
for (const actor of ["model", "writer"]) {
  onRestored.push({
    name: `${actor}:replace restored red>silver`,
    run: (w) => edit(w, actor, [{ p: 0, op: word("red", "silver") }]),
  });
  onRestored.push({
    name: `${actor}:delete restored red`,
    run: (w) => edit(w, actor, [{ p: 0, op: word("red", "") }]),
  });
  onRestored.push({
    name: `${actor}:insert inside restored`,
    run: (w) => edit(w, actor, [{ p: 0, op: inside("red", "X") }]),
  });
  onRestored.push({
    name: `${actor}:insert before restored`,
    run: (w) => edit(w, actor, [{ p: 0, op: before("red", "X") }]),
  });
  onRestored.push({
    name: `${actor}:insert after restored`,
    run: (w) => edit(w, actor, [{ p: 0, op: after("red", "X") }]),
  });
}
let inflight: { p: number; op: TextOp } | null = null;
function discardWithReply(w: World, rows: Row[]): void {
  const staged = inflight ? stage(w, inflight.p, inflight.op) : null;
  discard(w, rows);
  save(w, staged);
}
const round2: Step[] = [
  { name: "one round", run: () => {} },
  {
    name: "Discard again, then replace restored red>teal",
    run: (w) => {
      for (const c of classesOf(w, 0)) discardWithReply(w, c);
      const s = texts(w.draft)[0];
      if (s.includes("red")) edit(w, "model", [{ p: 0, op: word("red", "teal") }]);
    },
  },
  {
    name: "Discard again, then writer deletes restored red",
    run: (w) => {
      for (const c of classesOf(w, 0)) discardWithReply(w, c);
      const s = texts(w.draft)[0];
      if (s.includes("red")) edit(w, "writer", [{ p: 0, op: word("red", "") }]);
    },
  },
];
const extra: Step[] = [
  { name: "no writer typing in p2", run: () => {} },
  {
    name: "writer types in p2",
    run: (w) => {
      const s = texts(w.draft)[2];
      edit(w, "writer", [{ p: 2, op: after(s.includes("hill") ? "hill" : s.split(" ")[0], "!") }]);
    },
  },
];
type End = { name: string; ops: string[] };
const ends: End[] = [
  ["A0"],
  ["D0"],
  ["W"],
  ["A0", "A1"],
  ["A1", "A0"],
  ["D0", "W"],
  ["A1", "D0", "W"],
  ["A0", "W"],
  ["A2", "A0"],
  ["D2", "A0"],
  ["A0", "D2", "W"],
  ["D0", "A2"],
].map((o) => ({ name: o.join(","), ops: o }));
function end(w: World, op: string) {
  if (op === "W") {
    applyWhole(w);
    return;
  }
  const p = Number(op.slice(1));
  const cs = classesOf(w, p);
  if (op[0] === "A") {
    for (const c of cs) applySelected(w, classesOf(w, p).find((k) => k[0].id === c[0].id) ?? c);
  } else {
    for (const c of [...cs].reverse()) {
      const now = classesOf(w, p).find((k) => k[0].id === c[0].id);
      if (now) discard(w, now);
    }
  }
}

const REPLIES = [
  { name: "none", r: null },
  { name: "other paragraph", r: { p: 2, op: word("green", "lime") } },
  { name: "same paragraph", r: { p: 0, op: word("fox", "cat") } },
];
function runCase(
  model: Model,
  f: Step,
  rp: (typeof REPLIES)[number],
  s: Step,
  r2: Step,
  x: Step,
  e: End,
): void {
  const w = world(model);
  inflight = rp.r;
  const check = () => {
    expect(texts(w.live)).toEqual(w.oracle.live);
    expect(texts(w.draft)).toEqual(w.oracle.pend.map((q, i) => q ?? w.oracle.live[i]));
    cold(w);
  };
  try {
    f.run(w);
    edit(w, "model", [{ p: 1, op: word("blue", "azure") }]);
    check();
    for (const c of classesOf(w, 0)) discardWithReply(w, c);
    check();
    s.run(w);
    check();
    r2.run(w);
    check();
    x.run(w);
    check();
    for (const op of e.ops) {
      end(w, op);
      check();
    }
  } finally {
    w.live.destroy();
    w.draft.destroy();
  }
}
describe("Discard cancellation closure v2 sweep", () => {
  it.each(
    first.flatMap((f) => REPLIES.map((rp) => ({ name: f.name, reply: rp.name, f, rp }))),
  )("$name, $reply: 80 cold histories", ({ f, rp }) => {
    for (const s of onRestored.filter((s) => s.name.startsWith("model:")))
      for (const r2 of round2.slice(0, 2))
        for (const x of extra)
          for (const e of [ends[0], ends[1], ends[3], ends[5]]) runCase("A", f, rp, s, r2, x, e);
  });
  it.each([
    "A_oneWay",
    "A_noCarry",
    "A_restorationJoins",
    "B",
  ] as const)("kills negative control %s", (model) => {
    const f = model === "A_oneWay" ? first[1] : first[0],
      rp = model === "B" ? REPLIES[1] : REPLIES[0];
    expect(() =>
      runCase(
        model,
        f,
        rp,
        onRestored[1],
        round2[0],
        extra[0],
        model === "A_restorationJoins" ? ends[1] : ends[0],
      ),
    ).toThrow(
      model === "B"
        ? "BranchStaleUpdateError"
        : model === "A_noCarry"
          ? "BranchPeerIntegrationError"
          : /to deeply equal/,
    );
  });
  it.each([
    "insert inside gold",
    "replace gold with golden",
  ])("accepts overlapping in-flight reply: %s", (mode) => {
    const w = world("A");
    try {
      first[0].run(w);
      edit(w, "model", [{ p: 1, op: word("blue", "azure") }]);
      const fork = clone(w.draft),
        o = mode === "insert inside gold" ? inside("gold", "X") : word("gold", "golden");
      const operation = o(texts(fork)[0]);
      const update = capture(fork, () => {
        const t = xt(fork, 0);
        if (operation.del) t.delete(operation.at, operation.del);
        t.insert(operation.at, operation.ins);
      });
      fork.destroy();
      inflight = null;
      for (const c of classesOf(w, 0)) discard(w, c);
      cold(w);
      if (!update) throw Error("No staged update");
      const refork = clone(w.live);
      try {
        for (const row of w.rows)
          if (row.status !== "discarded" && row.kind === "write") Y.applyUpdate(refork, row.update);
        Y.applyUpdate(refork, update);
        expect(integrated(refork, [update])).toBe(false);
        expect(texts(refork)).toEqual(["the red fox", "azure sky", "green hill"]);
      } finally {
        refork.destroy();
      }
      Y.applyUpdate(w.draft, update);
      expect(texts(w.draft)).toEqual([
        mode === "insert inside gold" ? "the redX fox" : "the redgolden fox",
        "azure sky",
        "green hill",
      ]);
    } finally {
      w.live.destroy();
      w.draft.destroy();
    }
  });
});
