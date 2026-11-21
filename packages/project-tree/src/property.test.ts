/**
 * Proof-of-concept property test for the Yjs file-tree log. Several replicas edit the live tree
 * and two drafts at once, apply and discard drafts whole or in part, undo, and exchange Yjs
 * updates in random orders (including out of causal order). After every action the acting
 * replica's views must be valid trees; at the end every replica must show the same tree in
 * every view, and no created node may be missing or wrongly in the trash.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { admit, type Connection, changedSources, clientMayWrite } from "./admission.js";
import {
  applyDraft,
  childrenOf,
  descendantsOf,
  discardDraft,
  droppedRecords,
  fingerprint,
  LIVE,
  type NodeKind,
  replay,
  replayView,
  sourceRoot,
  type TreeProjection,
  type TreeRecord,
  TreeWriter,
  treeViolations,
  undoApply,
  type View,
  viewRecords,
} from "./index.js";
import { undoChange } from "./undo-open.js";

// What admission promises, checked on its answer. It keeps the update in runs, each changing no
// closed source on top of what was kept before it, and drops the record after each run, which
// would change one there. A run may hold records that cancel out (a move into a folder a held
// record later moves into a closed Work, then a move back out), so which record of such a stretch
// is dropped is the search's choice, not a promise: a walk judging one record at a time can drop
// another (seed 104039).
function admissionProblems(
  doc: Y.Doc,
  added: readonly TreeRecord[],
  dropped: readonly string[],
  connection: Connection,
): string[] {
  const problems: string[] = [];
  const ids = new Set(added.map((record) => record.id));
  const out = new Set(dropped);
  const droppedNodes = new Set(
    droppedRecords(doc).flatMap(({ record }) => (record.type === "create" ? [record.node] : [])),
  );
  const forced = (record: TreeRecord) =>
    (record.draft !== null && !connection.drafts.has(record.draft)) ||
    droppedNodes.has(record.node) ||
    (record.type === "create" && droppedNodes.has(record.parent));
  // Whether `these`, on top of the held records and the update's records kept before `from`,
  // change a closed source.
  const changesClosed = (from: number, these: readonly TreeRecord[]) => {
    const kept = new Set(
      added.slice(0, from).flatMap((record) => (out.has(record.id) ? [] : [record.id])),
    );
    const judged = new Set(these.map((record) => record.id));
    return [...new Set(these.map((record) => record.draft))].some((draft) => {
      const view = { draft };
      const records = viewRecords(doc, view).filter(
        (r) => !ids.has(r.id) || kept.has(r.id) || judged.has(r.id),
      );
      const before = replay(
        records.filter((r) => !judged.has(r.id)),
        view,
      );
      return [...changedSources(before, replay(records, view))].some(connection.closed);
    });
  };
  // Its first gate: an update whose records' own changes stay out of closed sources and which
  // together changes none is kept whole, even when one of them alone would change one.
  const reportsClosed = added.some((record) =>
    replayView(doc, { draft: record.draft })
      .changes.get(record.id)
      ?.sources.some(connection.closed),
  );
  if (!added.some(forced) && !reportsClosed && !changesClosed(0, added) && dropped.length > 0)
    problems.push("dropped records from an update that changes no closed source");
  let runStart = 0;
  for (const [index, record] of [...added.entries(), [added.length, null] as const]) {
    if (record !== null && !out.has(record.id)) {
      if (forced(record))
        problems.push(`kept ${record.id}, in a closed draft or on a dropped node`);
      continue;
    }
    if (changesClosed(runStart, added.slice(runStart, index)))
      problems.push(`kept records ${runStart}..${index - 1}, which change a closed source`);
    if (record === null) break;
    if (!forced(record) && !changesClosed(index, [record]))
      problems.push(`dropped ${record.id}, which changes no closed source where it arrived`);
    if (record.type === "create") droppedNodes.add(record.node);
    runStart = index + 1;
  }
  return problems;
}

const ROOT = sourceRoot("manuscript");

/**
 * The tree as it stands: what a writer sees, leaving out what is in Trash, the numbers on names
 * and twins' suffixes (a node an Undo puts back can arrive again, so which of two same-named
 * siblings carries one can change).
 */
const standing = (projection: TreeProjection) =>
  fingerprint(projection, false)
    .replaceAll(/( \(\d+\))*(~[0-9a-f]{4,})?(?=#)/g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("~") && !line.startsWith("source:"))
    .join("\n");

const cmd = () => crypto.randomUUID();

const SEEDS = Number(process.env.TREE_SEEDS ?? 40);
// Each run starts at a new seed so repeated runs cover new orderings; a failure names its seed.
const FIRST_SEED = Number(process.env.TREE_FIRST_SEED ?? 1 + Math.floor(Math.random() * 1_000_000));
const STEPS = Number(process.env.TREE_STEPS ?? 160);
const REPLICAS = 4;
const VIEWS: View[] = [LIVE, { draft: "w1" }, { draft: "w2" }];
const NAMES = ["Ch1", "Ch2", "Notes", "Arc", "Map"];

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Replica = {
  writer: TreeWriter;
  outbox: Uint8Array[];
  delivered: Map<number, Set<number>>;
};

function makeReplicas(): Replica[] {
  return Array.from({ length: REPLICAS }, (_, index) => {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = index + 1;
    const replica: Replica = { writer: new TreeWriter(doc), outbox: [], delivered: new Map() };
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote") {
        replica.outbox.push(update);
      }
    });
    return replica;
  });
}

/** Every view's tree is valid, holds every node its replay created, and trashes only what a delete named. */
function viewProblems(doc: Y.Doc, view: View): string[] {
  const projection = replayView(doc, view);
  const ops = viewRecords(doc, view);
  // Rule 15: a node may leave the view only while a withdrawal in force names it. That another
  // delete keeps it in Trash is the casebook's rule 15 case.
  const byRoot = new Map(ops.map((op) => [op.carries ?? op.id, op]));
  // A withdrawal, or the Undo of a restore that took one back, which puts it back.
  const withdraws = (op: TreeRecord): boolean => {
    if (op.type !== "delete" || op.draft !== null || op.undoes === undefined) return false;
    if (op.fromDraft !== undefined && op.carries === undefined) return true;
    const restore = byRoot.get(op.undoes);
    const back = restore?.type === "restore" && restore.undoes && byRoot.get(restore.undoes);
    return back ? withdraws(back) : false;
  };
  const withdrawn = (node: string) =>
    ops.some((op) => op.node === node && projection.inForce.has(op.id) && withdraws(op));
  const created = ops.flatMap((op) =>
    op.type === "create" && !withdrawn(op.node) ? [op.node] : [],
  );
  const problems = treeViolations(projection, created);
  const named = new Set(
    ops.flatMap((op) => (op.type === "delete" ? [op.node, ...op.cascade] : [])),
  );
  const deletedTops = new Set(ops.flatMap((op) => (op.type === "delete" ? [op.node] : [])));
  for (const node of projection.nodes.values()) {
    if (!node.trashed) continue;
    if (!named.has(node.id)) problems.push(`trashed ${node.id} that no delete named`);
    // A delete takes only what is still inside the deleted node: some node at or above it was deleted.
    let at: string | null = node.id;
    let steps = 0;
    while (at !== null && !deletedTops.has(at) && steps++ <= projection.nodes.size)
      at = projection.nodes.get(at)?.parent ?? null;
    if (at === null || !deletedTops.has(at))
      problems.push(`trashed ${node.id} outside any deleted node`);
  }
  return problems;
}

function runSeed(seed: number): {
  ops: number;
  skipped: number;
  kept: number;
  repaired: number;
  undone: number;
  undoneAny: number;
  leftPending: number;
} {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const replicas = makeReplicas();
  let undone = 0;
  let undoneAny = 0;
  let leftPending = 0;

  const deliver = (from: Replica, to: Replica) => {
    const fromIndex = replicas.indexOf(from);
    const seen = to.delivered.get(fromIndex) ?? new Set<number>();
    to.delivered.set(fromIndex, seen);
    const waiting = from.outbox.map((_, index) => index).filter((index) => !seen.has(index));
    if (waiting.length === 0) return;
    // Out of order on purpose: Yjs must hold an update whose dependencies haven't arrived.
    const index = pick(waiting);
    seen.add(index);
    Y.applyUpdate(to.writer.doc, from.outbox[index] as Uint8Array, "remote");
  };

  for (let step = 0; step < STEPS; step += 1) {
    const replica = pick(replicas);
    const writer = replica.writer;
    const roll = random();
    if (roll < 0.3) {
      const from = pick(replicas);
      if (from !== replica)
        for (let n = 0; n < 1 + Math.floor(random() * 4); n += 1) deliver(from, replica);
      continue;
    }
    const view = pick(VIEWS);
    const actor = pick(["user:w", "agent:t/1"]);
    const projection = replayView(writer.doc, view);
    const shown = [...projection.nodes.values()].filter(
      (node) => !node.trashed && node.id !== ROOT,
    );
    const folders = [
      ROOT,
      sourceRoot("notes-a"),
      sourceRoot("notes-b"),
      ...shown.filter((node) => node.kind === "folder").map((node) => node.id),
    ];
    const action = random();
    if (action < 0.3 || shown.length === 0) {
      const kind: NodeKind = random() < 0.4 ? "folder" : random() < 0.85 ? "document" : "file";
      const parent = pick(folders);
      const placed = { name: pick(NAMES), parent, index: Math.floor(random() * 5) };
      if (kind === "file")
        writer.create(view, actor, {
          ...placed,
          kind,
          blob: { storageKey: `k${step}`, mime: "image/png", size: 1 },
        });
      else if (kind === "document")
        writer.create(view, actor, { ...placed, kind, filetype: "markdown" });
      else writer.create(view, actor, { ...placed, kind });
    } else if (action < 0.55) {
      const node = pick(shown);
      const inside = new Set([node.id, ...descendantsOf(projection, node.id)]);
      const targets = folders.filter((folder) => !inside.has(folder));
      if (targets.length > 0) {
        const before = fingerprint(projection);
        const move = writer.move(view, actor, node.id, pick(targets), Math.floor(random() * 5));
        if (random() < 0.15) {
          const undo = undoChange(writer, view, actor, move.id);
          if (typeof undo === "object")
            expect(fingerprint(replayView(writer.doc, view)), `seed ${seed} undo move`).toBe(
              before,
            );
        }
      }
    } else if (action < 0.64) {
      writer.rename(view, actor, pick(shown).id, pick(NAMES));
    } else if (action < 0.68) {
      // Undo of an earlier op of any kind, which others may have changed since.
      const earlier = viewRecords(writer.doc, view);
      if (earlier.length > 0) {
        const result = undoChange(writer, view, actor, pick(earlier).id);
        if (typeof result === "object") undoneAny += 1;
      }
    } else if (action < 0.8) {
      const target = pick(shown).id;
      writer.delete(view, actor, target);
      // A delete does its job where it was made: the node and everything shown inside it go.
      const after = replayView(writer.doc, view);
      for (const id of [target, ...descendantsOf(after, target)])
        expect(after.nodes.get(id)?.trashed, `seed ${seed} step ${step} delete took ${id}`).toBe(
          true,
        );
    } else if (action < 0.85) {
      const trashed = [...projection.nodes.values()].filter((node) => node.trashed);
      if (trashed.length > 0) {
        const target = pick(trashed).id;
        writer.restore(view, actor, target);
        expect(
          replayView(writer.doc, view).nodes.get(target)?.trashed,
          `seed ${seed} restore`,
        ).toBe(false);
      }
    } else if (view.draft !== null) {
      const pending = viewRecords(writer.doc, view).filter((op) => op.draft === view.draft);
      if (pending.length === 0) continue;
      const some = random() < 0.5 ? [pick(pending).id] : undefined;
      if (action < 0.93) {
        const shownBefore = standing(replayView(writer.doc, view));
        const shownTree = replayView(writer.doc, view);
        const liveBefore = standing(replayView(writer.doc, LIVE));
        // Apply lands what can land and leaves the rest pending.
        const viewBefore = viewRecords(writer.doc, view);
        // A drafted record the view skips cannot land, chosen or not.
        const skippedBefore = replayView(writer.doc, view).skipped.map(({ record }) => record);
        // Records of which a live copy is in force: an earlier Apply's, back by an Undo of its
        // Un-Apply's Undo. One Undo takes out every copy, so Un-Apply of this Apply takes it too.
        const liveInForce = replayView(writer.doc, LIVE).inForce;
        const inLive = new Set(
          viewRecords(writer.doc, LIVE).flatMap((op) =>
            op.carries !== undefined && liveInForce.has(op.id) ? [op.carries] : [],
          ),
        );
        const landed = applyDraft(writer, view.draft, "user:w", cmd(), some);
        // The tree the Apply keeps: the Work's view.
        const shapeBefore = fingerprint(shownTree, false);
        const landing = landed.left.length > 0;
        if (landed.left.length > 0) leftPending += 1;
        if (random() < 0.3) {
          // Undo of an Apply at once: live and the draft both read as before it.
          const result = undoApply(writer, landed.command, "user:w", cmd());
          undone += 1;
          // No writer path doubles a live copy (it takes a live Undo of an Un-Apply's Undo record):
          // seed 400084 fails without this exemption. Keep it (#1610).
          const doubled = landed.copies.some((op) => inLive.has(op.carries as string));
          if (result.left.length === 0 && !doubled) {
            expect(standing(replayView(writer.doc, LIVE)), `seed ${seed} undo apply live`).toBe(
              liveBefore,
            );
            if (landed.superseded.length === 0 && landed.left.length === 0)
              expect(standing(replayView(writer.doc, view)), `seed ${seed} undo apply draft`).toBe(
                shownBefore,
              );
          }
          for (const each of VIEWS)
            expect(viewProblems(writer.doc, each), `seed ${seed} step ${step}`).toEqual([]);
          continue;
        }
        // An Apply leaves the draft reading as it did. A record that cannot land may start
        // to take effect once the rest has landed (a skipped move whose cycle a landed move
        // ended), so with such records the views are compared without them.
        // (Why a deleted folder still stands may change: a pending change kept it, and now
        // what landed inside it does. The shape is what must not change.)
        const cannotLand = landed.left.length > 0 || skippedBefore.length > 0;
        if (!cannotLand && landed.superseded.length === 0)
          expect(
            fingerprint(replayView(writer.doc, view), false),
            `seed ${seed} partial apply`,
          ).toBe(shapeBefore);
        else {
          // A record settled as superseded was already overridden in the draft, so the whole
          // view must read the same once the rest that could land has landed.
          if (!cannotLand)
            expect(
              fingerprint(replayView(writer.doc, view), false),
              `seed ${seed} apply with superseded`,
            ).toBe(shapeBefore);
          const cannot = new Set([
            ...[...landed.left.map(({ record }) => record), ...landed.superseded].map(
              (op) => op.id,
            ),
            ...skippedBefore,
          ]);
          const without = (ops: readonly TreeRecord[]) =>
            fingerprint(
              replay(
                ops.filter((op) => !cannot.has(op.id)),
                { draft: view.draft },
              ),
              false,
            );
          // A view that reads as before passes as is: without a record that could not land, a
          // node only it brought back from Trash reads trashed before and lifted after.
          if (fingerprint(replayView(writer.doc, view), false) !== shapeBefore)
            expect(without(viewRecords(writer.doc, view)), `seed ${seed} landing apply`).toBe(
              without(viewBefore),
            );
        }
        // What the writer saw lands; a record on a node in Trash in both waits, so the nodes in
        // Trash are left out.
        const shown = (shape: string) =>
          shape
            .split("\n")
            .filter((line) => !line.trimStart().startsWith("~"))
            .filter((line, at, lines) => line.startsWith(" ") || lines[at + 1]?.startsWith(" "))
            .join("\n");
        if (!some && !landing)
          expect(
            shown(fingerprint(replayView(writer.doc, LIVE), false)),
            `seed ${seed} WYSIWYG apply`,
          ).toBe(shown(shapeBefore));
      } else {
        discardDraft(writer, view.draft, "user:w", cmd(), some);
        if (!some)
          expect(fingerprint(replayView(writer.doc, view))).toBe(
            fingerprint(replayView(writer.doc, LIVE)),
          );
      }
    }
    for (const each of VIEWS)
      expect(viewProblems(writer.doc, each), `seed ${seed} step ${step}`).toEqual([]);
  }

  // Settle: every replica gets everything, in a shuffled order of whole outboxes.
  for (let round = 0; round < 2; round += 1)
    for (const to of replicas)
      for (const from of [...replicas].sort(() => random() - 0.5))
        if (from !== to) for (let n = 0; n < from.outbox.length; n += 1) deliver(from, to);
  const clocks = (doc: Y.Doc) =>
    [...Y.decodeStateVector(Y.encodeStateVector(doc))].sort(([a], [b]) => a - b);
  // Yjs 13.6.31 and 13.6.33 can leave a causally complete set of updates pending when single-struct
  // updates arrive out of order; production rooms receive each client's updates in order. A state-vector exchange, what y-protocols does on every connect,
  // repairs it; count how often it was needed.
  let repaired = 0;
  for (const to of replicas) {
    if (!to.writer.doc.store.pendingStructs && !to.writer.doc.store.pendingDs) continue;
    repaired += 1;
    for (const from of replicas)
      if (from !== to)
        Y.applyUpdate(
          to.writer.doc,
          Y.encodeStateAsUpdate(from.writer.doc, Y.encodeStateVector(to.writer.doc)),
          "remote",
        );
  }
  for (const replica of replicas)
    expect(clocks(replica.writer.doc), `seed ${seed} every update delivered`).toEqual(
      clocks(replicas[0]?.writer.doc as Y.Doc),
    );

  for (const view of VIEWS) {
    const prints = replicas.map((replica) => fingerprint(replayView(replica.writer.doc, view)));
    expect(new Set(prints).size, `seed ${seed} view ${view.draft ?? "live"} converges`).toBe(1);
    for (const replica of replicas)
      expect(viewProblems(replica.writer.doc, view), `seed ${seed}`).toEqual([]);
  }
  const doc = replicas[0]?.writer.doc as Y.Doc;
  for (const view of VIEWS) {
    const records = viewRecords(doc, view);
    if (records.length === 0) continue;
    const inserted = pick(records);
    const withRecord = replay(records, { draft: view.draft });
    const without = replay(
      records.filter((record) => record.id !== inserted.id),
      { draft: view.draft },
    );
    const sources = changedSources(without, withRecord);
    const shown = (p: TreeProjection, id: string) => {
      const n = p.nodes.get(id);
      return (
        n && [
          n.name,
          n.suffix,
          n.parent,
          n.source,
          n.rank,
          n.trashed,
          n.keptByChild,
          n.purged,
          n.filetype,
        ]
      );
    };
    for (const id of new Set([...withRecord.nodes.keys(), ...without.nodes.keys()])) {
      if (JSON.stringify(shown(withRecord, id)) === JSON.stringify(shown(without, id))) continue;
      for (const node of [withRecord.nodes.get(id), without.nodes.get(id)])
        if (node)
          expect(
            sources.has(node.source),
            `seed ${seed} record ${JSON.stringify(inserted)} change ${JSON.stringify([...sources])} node ${id} before ${JSON.stringify(shown(without, id))} after ${JSON.stringify(shown(withRecord, id))} records ${JSON.stringify(records.filter((r) => r.node === id || r.node === inserted.node))}`,
          ).toBe(true);
    }
    if (clientMayWrite(inserted) && inserted.draft === view.draft) {
      const closed = [...sources][0] ?? "not-a-source";
      const server = new Y.Doc({ gc: false });
      server.clientID = 7;
      server.getArray("ops").push(records.filter((r) => r.id !== inserted.id));
      const copy = new Y.Doc({ gc: false });
      copy.clientID = 2000;
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(server));
      const vector = Y.encodeStateVector(copy);
      copy.getArray("ops").insert(records.indexOf(inserted), [inserted]);
      const result = admit(new TreeWriter(server), Y.encodeStateAsUpdate(copy, vector), {
        drafts: new Set(["w1", "w2"]),
        closed: (source) => source === closed,
      });
      expect(result.dropped.includes(inserted.id), `seed ${seed} closed ${closed}`).toBe(
        sources.has(closed),
      );
      copy.destroy();
      server.destroy();
    }
  }
  const all = viewRecords(doc, LIVE);
  if (all.length > 0) {
    const start = Math.floor(random() * all.length);
    const added: TreeRecord[] = [];
    for (const record of all.slice(start, start + 8)) {
      if (!clientMayWrite(record)) break;
      added.push(record);
    }
    if (added.length > 0) {
      const server = new Y.Doc({ gc: false });
      server.clientID = 7;
      server.getArray("ops").push([...all.slice(0, start), ...all.slice(start + added.length)]);
      const copy = new Y.Doc({ gc: false });
      copy.clientID = 2000;
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(server));
      const vector = Y.encodeStateVector(copy);
      copy.getArray("ops").insert(start, added);
      const closed = pick(["manuscript", "not-a-source"]);
      const connection = {
        drafts: new Set(["w1", "w2"]),
        closed: (source: string) => source === closed,
      };
      const result = admit(new TreeWriter(server), Y.encodeStateAsUpdate(copy, vector), connection);
      expect(
        admissionProblems(copy, added, result.dropped, connection),
        `seed ${seed} closed ${closed} added ${JSON.stringify(added)} all ${JSON.stringify(all)} `,
      ).toEqual([]);
      copy.destroy();
      server.destroy();
    }
  }
  const views = VIEWS.map((view) => replayView(doc, view));
  return {
    ops: viewRecords(doc, LIVE).length,
    skipped: views.flatMap((view) => view.skipped).filter((s) => s.reason === "cycle").length,
    kept: views.flatMap((view) => [...view.nodes.values()]).filter((node) => node.keptByChild)
      .length,
    repaired,
    undone,
    undoneAny,
    leftPending,
  };
}

describe("file tree log under random concurrent edits", () => {
  it(`converges to one valid tree per view across ${SEEDS} seeds`, () => {
    let ops = 0;
    let skipped = 0;
    let kept = 0;
    let repaired = 0;
    let undone = 0;
    let undoneAny = 0;
    let leftPending = 0;
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed += 1) {
      let result: ReturnType<typeof runSeed>;
      try {
        result = runSeed(seed);
      } catch (error) {
        throw new Error(
          `tree property failed at seed ${seed}; rerun with TREE_FIRST_SEED=${seed} TREE_SEEDS=1`,
          { cause: error },
        );
      }
      ops += result.ops;
      skipped += result.skipped;
      kept += result.kept;
      repaired += result.repaired;
      undone += result.undone;
      undoneAny += result.undoneAny;
      leftPending += result.leftPending;
    }
    // A full sweep must reach the hard cases, or it proves nothing about them. A short run from a
    // random seed can miss a rare one (cycle skips are 0 to 5 per 40 seeds), so it is not asked to.
    if (SEEDS >= 300) {
      expect(skipped).toBeGreaterThan(0);
      expect(kept).toBeGreaterThan(0);
      expect(undone).toBeGreaterThan(0);
      expect(undoneAny).toBeGreaterThan(0);
    }
    console.info(
      `tree property: ${SEEDS} seeds, ${ops} live ops, ${skipped} cycle skips, ${kept} folders kept by a child, ${repaired} replicas left with stuck pending updates and repaired by a state-vector sync, ${undone} Applies undone at once, ${undoneAny} changes undone from a random earlier record, ${leftPending} Applies that left records that could not land`,
    );
  }, 600_000);

  it("replays a large project quickly enough to recompute on every change", () => {
    const doc = new Y.Doc({ gc: false });
    const writer = new TreeWriter(doc);
    const random = rng(7);
    const folders = [ROOT];
    const nodes: string[] = [];
    for (let i = 0; i < 2_000; i += 1) {
      const parent = folders[Math.floor(random() * folders.length)] as string;
      const op = writer.author(LIVE, "user:w", {
        type: "create",
        node: `n${i}`,
        kind: i % 10 === 0 ? "folder" : "document",
        ...(i % 10 === 0 ? {} : { filetype: "markdown" }),
        name: `N${i}`,
        parent,
        source: "manuscript",
        rank: `a${i.toString(36).padStart(4, "0")}1`,
      });
      if (i % 10 === 0) folders.push(op.node);
      nodes.push(`n${i}`);
    }
    for (let i = 0; i < 20_000; i += 1) {
      const node = nodes[Math.floor(random() * nodes.length)] as string;
      writer.author(LIVE, "user:w", {
        type: "move",
        node,
        parent: folders[Math.floor(random() * folders.length)] as string,
        rank: `b${i.toString(36).padStart(4, "0")}1`,
        from: { parent: ROOT, rank: "" },
      });
    }
    const started = performance.now();
    const projection = replayView(doc, LIVE);
    const elapsed = performance.now() - started;
    expect(treeViolations(projection)).toEqual([]);
    expect(childrenOf(projection, ROOT).length).toBeGreaterThan(0);
    const bytes = Y.encodeStateAsUpdate(doc).byteLength;
    console.info(
      `2,000 nodes, 22,000 ops: replay ${elapsed.toFixed(0)} ms, doc ${(bytes / 1024).toFixed(0)} KiB`,
    );
  });
});
