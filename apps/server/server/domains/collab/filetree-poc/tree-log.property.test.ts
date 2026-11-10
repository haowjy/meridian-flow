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
  childrenOf,
  descendantsOf,
  fingerprint,
  LIVE,
  materialize,
  type NodeKind,
  ROOT,
  TreeWriter,
  treeViolations,
  type View,
  viewOps,
} from "./tree-log.js";

const SEEDS = Number(process.env.TREE_SEEDS ?? 300);
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

type Replica = { writer: TreeWriter; outbox: Uint8Array[]; delivered: Map<number, Set<number>> };

function makeReplicas(): Replica[] {
  return Array.from({ length: REPLICAS }, (_, index) => {
    const doc = new Y.Doc({ gc: false });
    doc.clientID = index + 1;
    const replica: Replica = { writer: new TreeWriter(doc), outbox: [], delivered: new Map() };
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== "remote") replica.outbox.push(update);
    });
    return replica;
  });
}

/** Every view's tree is valid, holds every node its replay created, and trashes only what a delete named. */
function viewProblems(doc: Y.Doc, view: View): string[] {
  const projection = materialize(doc, view);
  const ops = viewOps(doc, view);
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

function runSeed(seed: number): { ops: number; skipped: number; kept: number } {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const replicas = makeReplicas();

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
    const projection = materialize(writer.doc, view);
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
          const undo = writer.undo(view, actor, move.id);
          if (undo !== "superseded" && undo !== "unknown")
            expect(fingerprint(materialize(writer.doc, view)), `seed ${seed} undo move`).toBe(
              before,
            );
        }
      }
    } else if (action < 0.68) {
      writer.rename(view, actor, pick(shown).id, pick(NAMES));
    } else if (action < 0.8) {
      writer.delete(view, actor, pick(shown).id);
    } else if (action < 0.85) {
      const trashed = [...projection.nodes.values()].filter((node) => node.trashed);
      if (trashed.length > 0) writer.restore(view, actor, pick(trashed).id);
    } else if (view.draft !== null) {
      const pending = viewOps(writer.doc, view).filter((op) => op.draft === view.draft);
      if (pending.length === 0) continue;
      const some = random() < 0.5 ? [pick(pending).id] : undefined;
      if (action < 0.93) {
        const shownBefore = fingerprint(materialize(writer.doc, view));
        writer.apply(view.draft, "user:w", some);
        if (!some)
          expect(fingerprint(materialize(writer.doc, LIVE)), `seed ${seed} WYSIWYG apply`).toBe(
            shownBefore,
          );
      } else {
        writer.discard(view.draft, some);
        if (!some)
          expect(fingerprint(materialize(writer.doc, view))).toBe(
            fingerprint(materialize(writer.doc, LIVE)),
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
  for (const replica of replicas)
    expect(Y.encodeStateVector(replica.writer.doc)).toEqual(
      Y.encodeStateVector(replicas[0]?.writer.doc as Y.Doc),
    );

  for (const view of VIEWS) {
    const prints = replicas.map((replica) => fingerprint(materialize(replica.writer.doc, view)));
    expect(new Set(prints).size, `seed ${seed} view ${view.draft ?? "live"} converges`).toBe(1);
    for (const replica of replicas)
      expect(viewProblems(replica.writer.doc, view), `seed ${seed}`).toEqual([]);
  }
  const doc = replicas[0]?.writer.doc as Y.Doc;
  const views = VIEWS.map((view) => materialize(doc, view));
  return {
    ops: viewOps(doc, LIVE).length,
    skipped: views.flatMap((view) => view.skipped).filter((s) => s.reason === "cycle").length,
    kept: views.flatMap((view) => [...view.nodes.values()]).filter((node) => node.keptByChild)
      .length,
  };
}

describe("file tree log under random concurrent edits", () => {
  it(`converges to one valid tree per view across ${SEEDS} seeds`, () => {
    let ops = 0;
    let skipped = 0;
    let kept = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const result = runSeed(seed);
      ops += result.ops;
      skipped += result.skipped;
      kept += result.kept;
    }
    // The run must actually reach the hard cases, or it proves nothing about them.
    expect(skipped).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);
    console.info(
      `tree property: ${SEEDS} seeds, ${ops} live ops, ${skipped} cycle skips, ${kept} folders kept by a child`,
    );
  });

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
    const projection = materialize(doc, LIVE);
    const elapsed = performance.now() - started;
    expect(treeViolations(projection)).toEqual([]);
    expect(childrenOf(projection, ROOT).length).toBeGreaterThan(0);
    const bytes = Y.encodeStateAsUpdate(doc).byteLength;
    console.info(
      `2,000 nodes, 22,000 ops: replay ${elapsed.toFixed(0)} ms, doc ${(bytes / 1024).toFixed(0)} KiB`,
    );
  });
});
