/**
 * Proof code. The engine that takes one record at a time must give exactly the tree that a
 * replay from the start gives, after every step, in live and in two Works' views.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { syncEngine, TreeEngine } from "./tree-engine.js";
import {
  descendantsOf,
  fingerprint,
  LIVE,
  materialize,
  replay,
  ROOT,
  type TreeOp,
  type TreeProjection,
  TreeWriter,
  type View,
  viewOps,
} from "./tree-log.js";

const VIEWS: View[] = [LIVE, { draft: "w1" }, { draft: "w2" }];
const NAMES = ["Notes", "Ch1", "Ch2", "Arc", "Map"];

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function same(engine: TreeEngine, truth: TreeProjection, label: string) {
  const got = engine.projection();
  expect(fingerprint(got), label).toBe(fingerprint(truth));
  expect(got.skipped, `${label} skipped`).toEqual(truth.skipped);
  expect(got.rescued, `${label} rescued`).toEqual(truth.rescued);
  expect([...got.nodes.keys()].sort(), `${label} nodes`).toEqual([...truth.nodes.keys()].sort());
  for (const [id, node] of truth.nodes) expect(got.nodes.get(id), `${label} ${id}`).toEqual(node);
}

describe("a record applied to the last state, against a replay from the start", () => {
  it("is the same tree after every step of 300 histories: every record kind, Undo, Apply in whole and in part, Discard, Undo of an Apply", () => {
    let steps = 0;
    let pushes = 0;
    let pops = 0;
    let rowsOver = 0;
    const kinds: Record<string, number> = {};
    for (let seed = 1; seed <= 300; seed += 1) {
      const doc = new Y.Doc({ gc: false });
      const writer = new TreeWriter(doc);
      const random = rng(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
      const engines = VIEWS.map((view) => new TreeEngine({ draft: view.draft }));
      const before = VIEWS.map(() => new Map<string, string>());
      const applies: TreeOp[][] = [];
      const count = (kind: string) => {
        kinds[kind] = (kinds[kind] ?? 0) + 1;
      };
      for (let step = 0; step < 140; step += 1) {
        const view = pick(VIEWS);
        const projection = materialize(doc, view);
        const shown = [...projection.nodes.values()].filter(
          (node) => !node.trashed && node.id !== ROOT,
        );
        const folders = [ROOT, ...shown.filter((n) => n.kind === "folder").map((n) => n.id)];
        const roll = random();
        if (roll < 0.28 || shown.length === 0) {
          writer.create(view, "user:w", {
            kind: random() < 0.4 ? "folder" : "document",
            name: pick(NAMES),
            parent: pick(folders),
            index: Math.floor(random() * 4),
          });
          count("create");
        } else if (roll < 0.5) {
          const node = pick(shown);
          const inside = new Set([node.id, ...descendantsOf(projection, node.id)]);
          // One move in five aims inside its own subtree, so loops are met.
          const targets = random() < 0.2 ? folders : folders.filter((f) => !inside.has(f));
          if (targets.length > 0) {
            const move = writer.move(view, "agent:c/t", node.id, pick(targets), Math.floor(random() * 4));
            count("move");
            if (random() < 0.15 && writer.undo(view, "agent:c/t", move.id) !== "superseded") count("undo");
          }
        } else if (roll < 0.6) {
          writer.rename(view, "user:w", pick(shown).id, pick(NAMES));
          count("rename");
        } else if (roll < 0.72) {
          const made = writer.delete(view, "user:w", pick(shown).id);
          count("delete");
          if (random() < 0.2 && typeof writer.undo(view, "user:w", made.id) === "object") count("undo");
        } else if (roll < 0.8) {
          const trashed = [...projection.nodes.values()].filter((node) => node.trashed);
          if (trashed.length > 0) {
            writer.restore(view, "user:w", pick(trashed).id);
            count("restore");
          }
        } else if (view.draft !== null) {
          const pending = viewOps(doc, view).filter((op) => op.draft === view.draft);
          if (pending.length === 0) continue;
          const some = random() < 0.5 ? [pick(pending).id] : undefined;
          if (roll < 0.92) {
            const landed = writer.applyLanding(view.draft, "user:w", some);
            applies.push(landed.copies);
            count(some ? "apply part" : "apply");
            if (random() < 0.3 && writer.undoApply(landed.copies) === "undone") count("undo apply");
          } else {
            writer.discard(view.draft, some);
            count("discard");
          }
        } else if (applies.length > 0 && writer.undoApply(pick(applies)) === "undone")
          count("undo apply later");
        steps += 1;
        for (const [at, each] of VIEWS.entries()) {
          const engine = engines[at] as TreeEngine;
          const [pushed, popped] = [engine.pushes, engine.pops];
          const changed = syncEngine(engine, viewOps(doc, each));
          pushes += engine.pushes - pushed;
          pops += engine.pops - popped;
          const truth = materialize(doc, each);
          same(engine, truth, `seed ${seed} step ${step} ${each.draft ?? "live"}`);
          // The nodes it reports as changed cover every node whose row differs from before.
          const rows = before[at] as Map<string, string>;
          for (const [id, node] of truth.nodes) {
            const row = JSON.stringify([node.parent, node.displayName, node.rank, node.trashed, node.keptByChild, node.keptByPending]);
            if (rows.get(id) !== row && id !== ROOT)
              expect(changed.has(id), `seed ${seed} step ${step} row ${id}`).toBe(true);
            rows.set(id, row);
          }
          for (const id of [...rows.keys()])
            if (!truth.nodes.has(id)) {
              expect(changed.has(id), `seed ${seed} step ${step} gone ${id}`).toBe(true);
              rows.delete(id);
            }
          rowsOver += changed.size;
        }
      }
    }
    console.info(
      `engine: ${steps} steps in 300 histories, three views each; ${(pushes / steps / 3).toFixed(1)} records applied and ${(pops / steps / 3).toFixed(1)} taken back per view per step; ${(rowsOver / steps / 3).toFixed(1)} nodes re-derived per view per step; steps: ${JSON.stringify(kinds)}`,
    );
    for (const kind of ["create", "move", "rename", "delete", "restore", "undo", "apply", "apply part", "discard", "undo apply", "undo apply later"])
      expect(kinds[kind] ?? 0, kind).toBeGreaterThan(0);
  }, 600_000);

  it("is the same tree when a record lands in the middle of the list, as under several writers", () => {
    let insertions = 0;
    let reapplied = 0;
    for (let seed = 1; seed <= 150; seed += 1) {
      const doc = new Y.Doc({ gc: false });
      const writer = new TreeWriter(doc);
      const random = rng(seed * 31);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
      // A history to draw records from.
      for (let step = 0; step < 90; step += 1) {
        const projection = materialize(doc, LIVE);
        const shown = [...projection.nodes.values()].filter((n) => !n.trashed && n.id !== ROOT);
        const folders = [ROOT, ...shown.filter((n) => n.kind === "folder").map((n) => n.id)];
        const roll = random();
        if (roll < 0.35 || shown.length === 0)
          writer.create(LIVE, "user:w", { kind: random() < 0.4 ? "folder" : "document", name: pick(NAMES), parent: pick(folders) });
        else if (roll < 0.65) writer.move(LIVE, "user:w", pick(shown).id, pick(folders));
        else if (roll < 0.78) writer.rename(LIVE, "user:w", pick(shown).id, pick(NAMES));
        else if (roll < 0.92) writer.delete(LIVE, "user:w", pick(shown).id);
        else {
          const trashed = [...projection.nodes.values()].filter((n) => n.trashed);
          if (trashed.length > 0) writer.restore(LIVE, "user:w", pick(trashed).id);
        }
      }
      const all = viewOps(doc, LIVE);
      // Start from a random half of the records, in order, then let the others arrive one at
      // a time at their places in the list, as late records from another writer do.
      const late = new Set(all.filter(() => random() < 0.5).map((op) => op.id));
      let present = all.filter((op) => !late.has(op.id));
      const engine = new TreeEngine();
      syncEngine(engine, present);
      for (const op of [...all].filter((o) => late.has(o.id)).sort(() => random() - 0.5)) {
        late.delete(op.id);
        present = all.filter((o) => !late.has(o.id));
        const pushed = engine.pushes;
        syncEngine(engine, present);
        reapplied += engine.pushes - pushed;
        insertions += 1;
        same(engine, replay(present), `seed ${seed} insert ${op.id}`);
      }
    }
    console.info(
      `engine: ${insertions} records landed in the middle of a 90-record list; ${(reapplied / insertions).toFixed(1)} records applied per landing`,
    );
  }, 600_000);

  it("keeps a document a Work holds pending text of, as the replay does", () => {
    const doc = new Y.Doc({ gc: false });
    const writer = new TreeWriter(doc);
    const f = writer.create(LIVE, "user:w", { kind: "folder", name: "Doomed", parent: ROOT }).node;
    const ch = writer.create(LIVE, "user:w", { kind: "document", name: "Letter", parent: f }).node;
    const pendingText = new Set([ch]);
    const engine = new TreeEngine({ draft: "w1", pendingText });
    const view = { draft: "w1" };
    syncEngine(engine, viewOps(doc, view));
    writer.delete(LIVE, "user:w", f);
    const changed = syncEngine(engine, viewOps(doc, view));
    same(engine, materialize(doc, view, pendingText), "pending text");
    expect(engine.node(ch)).toMatchObject({ trashed: false, keptByPending: true });
    expect([...changed].sort()).toEqual([ch, f].sort());
    // The Work's text draft is applied or discarded: the chapter and its folder go to Trash.
    engine.setPendingText(new Set());
    expect([...engine.refresh()].sort()).toEqual([ch, f].sort());
    same(engine, materialize(doc, view), "pending text gone");
    engine.setPendingText(pendingText);
    engine.refresh();
    same(engine, materialize(doc, view, pendingText), "pending text back");
  });
});
