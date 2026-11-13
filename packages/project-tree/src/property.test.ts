/**
 * Proof-of-concept property test for the Yjs file-tree log. Several replicas edit the live tree
 * and two drafts at once, apply and discard drafts whole or in part, undo, and exchange Yjs
 * updates in random orders (including out of causal order). After every action the acting
 * replica's views must be valid trees; at the end every replica must show the same tree in
 * every view, and no created node may be missing or wrongly in the trash.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyDraft,
  childrenOf,
  descendantsOf,
  discardDraft,
  fingerprint,
  LIVE,
  type NodeKind,
  replay,
  replayView,
  sourceRoot,
  type TreeRecord,
  TreeWriter,
  treeViolations,
  undoApply,
  undoChange,
  type View,
  viewRecords,
} from "./index.js";

const ROOT = sourceRoot("manuscript");

const cmd = () => crypto.randomUUID();

const SEEDS = Number(process.env.TREE_SEEDS ?? 300);
const FIRST_SEED = Number(process.env.TREE_FIRST_SEED ?? 1);
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
  const created = ops.flatMap((op) => (op.type === "create" ? [op.node] : []));
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
  widened: number;
  leftPending: number;
} {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const replicas = makeReplicas();
  let undone = 0;
  let undoneAny = 0;
  let widened = 0;
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
      ...shown.filter((node) => node.kind === "folder").map((node) => node.id),
    ];
    const action = random();
    if (action < 0.3 || shown.length === 0) {
      const kind: NodeKind = random() < 0.4 ? "folder" : random() < 0.85 ? "document" : "file";
      const parent = pick(folders);
      writer.create(view, actor, {
        kind,
        name: pick(NAMES),
        parent,
        index: Math.floor(random() * 5),
        ...(kind === "file"
          ? { blob: { storageKey: `k${step}`, mime: "image/png", size: 1 } }
          : {}),
      });
    } else if (action < 0.55) {
      const node = pick(shown);
      const inside = new Set([node.id, ...descendantsOf(projection, node.id)]);
      const targets = folders.filter((folder) => !inside.has(folder));
      if (targets.length > 0) {
        const before = fingerprint(projection);
        const move = writer.move(view, actor, node.id, pick(targets), Math.floor(random() * 5));
        if (random() < 0.15) {
          const undo = undoChange(writer, view, actor, move.id);
          if (undo !== "superseded" && undo !== "unknown")
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
        const shownBefore = fingerprint(replayView(writer.doc, view));
        const shapeBefore = fingerprint(replayView(writer.doc, view), false);
        const liveBefore = fingerprint(replayView(writer.doc, LIVE));
        // Apply lands what can land and leaves the rest pending.
        const viewBefore = viewRecords(writer.doc, view);
        const landed = applyDraft(writer, view.draft, "user:w", cmd(), some);
        const landing = landed.left.length > 0;
        if (landed.blocked) widened += 1;
        if (landed.cannot.length > 0) leftPending += 1;
        if (random() < 0.3) {
          // Undo of an Apply at once: live and the draft both read as before it.
          expect(
            undoApply(writer, landed.command, landed.mark, "user:w", cmd()),
            `seed ${seed} undo apply`,
          ).toBe("undone");
          undone += 1;
          expect(fingerprint(replayView(writer.doc, LIVE)), `seed ${seed} undo apply live`).toBe(
            liveBefore,
          );
          expect(fingerprint(replayView(writer.doc, view)), `seed ${seed} undo apply draft`).toBe(
            shownBefore,
          );
          for (const each of VIEWS)
            expect(viewProblems(writer.doc, each), `seed ${seed} step ${step}`).toEqual([]);
          continue;
        }
        // An Apply leaves the draft reading as it did. A record that cannot land may start
        // to take effect once the rest has landed, so with such records the views are compared
        // without them.
        // (Why a deleted folder still stands may change: a pending change kept it, and now
        // what landed inside it does. The shape is what must not change.)
        if (landed.cannot.length === 0 && landed.superseded.length === 0)
          expect(
            fingerprint(replayView(writer.doc, view), false),
            `seed ${seed} partial apply`,
          ).toBe(shapeBefore);
        else {
          // A record settled as superseded was already overridden in the draft, so the whole
          // view must read the same once the rest that could land has landed.
          if (landed.cannot.length === 0)
            expect(
              fingerprint(replayView(writer.doc, view), false),
              `seed ${seed} apply with superseded`,
            ).toBe(shapeBefore);
          const cannot = new Set([...landed.cannot, ...landed.superseded].map((op) => op.id));
          const without = (ops: readonly TreeRecord[]) =>
            fingerprint(
              replay(
                ops.filter((op) => !cannot.has(op.id)),
                { draft: view.draft },
              ),
              false,
            );
          expect(without(viewRecords(writer.doc, view)), `seed ${seed} landing apply`).toBe(
            without(viewBefore),
          );
        }
        if (!some && !landing)
          expect(
            fingerprint(replayView(writer.doc, LIVE), false),
            `seed ${seed} WYSIWYG apply`,
          ).toBe(shapeBefore);
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
  // Yjs 13.6 can leave a causally complete set of updates pending when they arrive out of order
  // (yjs-pending.test.ts). A state-vector exchange, what y-protocols does on every connect,
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
  const views = VIEWS.map((view) => replayView(doc, view));
  return {
    ops: viewRecords(doc, LIVE).length,
    skipped: views.flatMap((view) => view.skipped).filter((s) => s.reason === "cycle").length,
    kept: views.flatMap((view) => [...view.nodes.values()]).filter((node) => node.keptByChild)
      .length,
    repaired,
    undone,
    undoneAny,
    widened,
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
    let widened = 0;
    let leftPending = 0;
    for (let seed = FIRST_SEED; seed < FIRST_SEED + SEEDS; seed += 1) {
      const result = runSeed(seed);
      ops += result.ops;
      skipped += result.skipped;
      kept += result.kept;
      repaired += result.repaired;
      undone += result.undone;
      undoneAny += result.undoneAny;
      widened += result.widened;
      leftPending += result.leftPending;
    }
    // The run must actually reach the hard cases, or it proves nothing about them.
    expect(skipped).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);
    expect(undone).toBeGreaterThan(0);
    expect(undoneAny).toBeGreaterThan(0);
    console.info(
      `tree property: ${SEEDS} seeds, ${ops} live ops, ${skipped} cycle skips, ${kept} folders kept by a child, ${repaired} replicas left with stuck pending updates and repaired by a state-vector sync, ${undone} Applies undone at once, ${undoneAny} changes undone from a random earlier record, ${leftPending} Applies that left records that could not land, ${widened} Applies that took nothing because what could land was tied to what could not`,
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
        name: `N${i}`,
        parent,
        source: "manuscript",
        rank: `a${i.toString(36).padStart(4, "0")}`,
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
        rank: `b${i.toString(36).padStart(4, "0")}`,
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
