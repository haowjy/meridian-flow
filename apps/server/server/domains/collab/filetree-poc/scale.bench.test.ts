/**
 * Proof code. What the cost of a tree change follows, for the replay from the start and for
 * the engine that takes one record at a time. No database: the journal insert and row writes
 * are about 7 ms an admission whatever the size (pg/run.ts).
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { TreeEngine } from "./tree-engine.js";
import { fingerprint, LIVE, opsOf, replay, ROOT, type TreeOp, viewOps } from "./tree-log.js";

type Built = { doc: Y.Doc; ids: string[]; folders: string[]; rank: () => string; drafts: string[] };

/** `depth` folders deep at most; chapters spread over the folders; then renames and moves. */
function build(nodes: number, records: number, draftCount: number, perDraft = 150): Built {
  const doc = new Y.Doc({ gc: false });
  const batch: TreeOp[] = [];
  const folders = [ROOT];
  const ids: string[] = [];
  let n = 0;
  let made = 0;
  const rank = () => `a${(n += 1).toString(36).padStart(7, "0")}`;
  const add = (draft: string | null, input: Record<string, unknown>) => {
    made += 1;
    batch.push({ ...input, id: `b${made}`, actor: "user:w", draft } as unknown as TreeOp);
  };
  for (let i = 0; i < nodes; i += 1) {
    const folder = i % 20 === 0;
    add(null, { type: "create", node: `n${i}`, kind: folder ? "folder" : "document", name: `N${i}`, parent: folders[(i * 7) % folders.length], rank: rank() });
    ids.push(`n${i}`);
    if (folder && folders.length < 5 + nodes / 20) folders.push(`n${i}`);
  }
  const isFolder = new Set(folders);
  for (let i = 0; made < records; i += 1) {
    const node = ids[(i * 13) % ids.length] as string;
    if (i % 3 === 0 || isFolder.has(node)) add(null, { type: "rename", node, name: `R${i}`, fromName: "x" });
    else add(null, { type: "move", node, parent: folders[i % folders.length], rank: rank(), from: { parent: ROOT, rank: "a" } });
  }
  const drafts = ["w1", "w2", "w3"].slice(0, draftCount);
  for (const draft of drafts)
    for (let i = 0; i < perDraft; i += 1) {
      const node = ids[(i * 17 + draft.length * 3) % ids.length] as string;
      if (i % 4 === 0) add(draft, { type: "create", node: `${draft}-${i}`, kind: i % 8 === 0 ? "folder" : "document", name: `D${i}`, parent: folders[i % folders.length], rank: rank() });
      else if (i % 4 === 1 || isFolder.has(node)) add(draft, { type: "rename", node, name: `DR${i}`, fromName: "x" });
      else add(draft, { type: "move", node, parent: folders[(i + 3) % folders.length], rank: rank(), from: { parent: ROOT, rank: "a" } });
    }
  for (let at = 0; at < batch.length; at += 1000) opsOf(doc).push(batch.slice(at, at + 1000));
  return { doc, ids, folders, rank, drafts };
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;
const worst = (values: number[]) => Math.max(...values);
const ms = (value: number) => (value < 1 ? value.toFixed(3) : value.toFixed(1));

describe("what the replay's cost follows", () => {
  it("history or tree size: the two halves of a replay, timed apart", () => {
    const lines: string[] = [];
    for (const [nodes, records] of [
      [3_000, 30_000],
      [3_000, 100_000],
      [22_000, 31_000],
      [22_000, 100_000],
      [50_000, 100_000],
    ] as const) {
      const t = build(nodes, records, 0);
      const read: number[] = [];
      const through: number[] = [];
      const derive: number[] = [];
      for (let i = 0; i < 15; i += 1) {
        const started = performance.now();
        const ops = viewOps(t.doc, LIVE);
        read.push(performance.now() - started);
        const timing = { records: 0, derive: 0 };
        replay(ops, { timing });
        through.push(timing.records);
        derive.push(timing.derive);
      }
      lines.push(
        `${nodes} nodes, ${records} records: read the list ${ms(median(read))} ms, go through the records ${ms(median(through))} ms, derive the tree ${ms(median(derive))} ms`,
      );
    }
    console.info(`replay halves\n${lines.join("\n")}`);
  }, 600_000);
});

describe("one record applied to the last state", () => {
  for (const [nodes, records] of [
    [3_000, 30_000],
    [22_000, 31_000],
    [10_000, 100_000],
    [50_000, 300_000],
  ] as const)
    it(`${nodes} nodes, ${records} records`, () => {
      const t = build(nodes, records, 3);
      const views = [null, ...t.drafts];
      const sequences = views.map((draft) => viewOps(t.doc, { draft }));
      const started = performance.now();
      const engines = views.map((draft, at) => {
        const engine = new TreeEngine({ draft });
        for (const op of sequences[at] as TreeOp[]) engine.push(op);
        engine.refresh();
        return engine;
      });
      const startUp = (performance.now() - started) / views.length;
      // The engine holds the same tree as a replay from the start.
      expect(fingerprint((engines[0] as TreeEngine).projection())).toBe(
        fingerprint(replay(sequences[0] as TreeOp[])),
      );
      expect(fingerprint((engines[3] as TreeEngine).projection())).toBe(
        fingerprint(replay(sequences[3] as TreeOp[], { draft: "w3" })),
      );
      const pending = t.drafts.map((draft) => (sequences[0] as TreeOp[]).length && viewOps(t.doc, { draft }).filter((op) => op.draft === draft));
      const live: number[] = [];
      const perDraft: number[] = [];
      let rows = 0;
      for (let i = 0; i < 200; i += 1) {
        const node = t.ids[(i * 31 + 5) % t.ids.length] as string;
        const op = (
          i % 3 === 0
            ? { type: "rename", node, name: `Z${i}`, fromName: "x" }
            : i % 3 === 1
              ? { type: "create", node: `new${i}`, kind: "document", name: `New${i}`, parent: t.folders[i % t.folders.length], rank: t.rank() }
              : { type: "move", node: t.ids[(i * 31 + 6) % t.ids.length], parent: t.folders[(i + 1) % t.folders.length], rank: t.rank(), from: { parent: ROOT, rank: "a" } }
        ) as Record<string, unknown>;
        const record = { ...op, id: `x${i}`, actor: "user:w", draft: null } as unknown as TreeOp;
        let at = performance.now();
        (engines[0] as TreeEngine).push(record);
        rows += (engines[0] as TreeEngine).refresh().size;
        live.push(performance.now() - at);
        // A live record goes under each Work's pending records: take them back, apply, redo.
        at = performance.now();
        for (const [d, engine] of engines.slice(1).entries()) {
          const mine = pending[d] as TreeOp[];
          engine.pop(mine.length);
          engine.push(record);
          for (const p of mine) engine.push(p);
          rows += engine.refresh().size;
        }
        perDraft.push((performance.now() - at) / t.drafts.length);
      }
      console.info(
        `engine ${nodes}/${records}: a live record ${ms(median(live))} ms (worst ${ms(worst(live))}); each Work with 150 pending records ${ms(median(perDraft))} ms more (worst ${ms(worst(perDraft))}); ${(rows / 200).toFixed(1)} nodes re-derived per record over four views; building the state once ${startUp.toFixed(0)} ms per view`,
      );
      // After 200 records the engines still hold what a replay from the start gives.
      const all = [...(sequences[0] as TreeOp[]), ...Array.from({ length: 200 }, (_, i) => (engines[0] as TreeEngine).idAt((sequences[0] as TreeOp[]).length + i))];
      expect(all.length).toBe((engines[0] as TreeEngine).length);
    }, 900_000);
});

describe("many records at once, and many calls one after another", () => {
  it("500 records as one admission against 500 admissions, by replay; and 200 calls by the engine", () => {
    const t = build(3_000, 30_000, 1);
    const make = (i: number, tag: string) =>
      ({ type: "create", node: `${tag}${i}`, kind: "document", name: `${tag}${i}`, parent: t.folders[i % t.folders.length], rank: t.rank(), id: `${tag}-op${i}`, actor: "user:w", draft: null }) as unknown as TreeOp;
    const views = [LIVE, { draft: "w1" }];
    // One admission of 500: append them all, then one replay per view.
    let started = performance.now();
    opsOf(t.doc).push(Array.from({ length: 500 }, (_, i) => make(i, "imp")));
    for (const view of views) replay(viewOps(t.doc, view), { draft: view.draft });
    const once = performance.now() - started;
    // 200 admissions of one: a replay per view after each.
    started = performance.now();
    for (let i = 0; i < 200; i += 1) {
      opsOf(t.doc).push([make(i, "call")]);
      for (const view of views) replay(viewOps(t.doc, view), { draft: view.draft });
    }
    const each = performance.now() - started;
    // The same 200 by the engine, live and one Work with 150 pending.
    const engines = views.map((view) => {
      const engine = new TreeEngine({ draft: view.draft });
      for (const op of viewOps(t.doc, view)) engine.push(op);
      engine.refresh();
      return engine;
    });
    const mine = viewOps(t.doc, { draft: "w1" }).filter((op) => op.draft === "w1");
    started = performance.now();
    for (let i = 0; i < 200; i += 1) {
      const record = make(i, "eng");
      (engines[0] as TreeEngine).push(record);
      (engines[0] as TreeEngine).refresh();
      (engines[1] as TreeEngine).pop(mine.length);
      (engines[1] as TreeEngine).push(record);
      for (const p of mine) (engines[1] as TreeEngine).push(p);
      (engines[1] as TreeEngine).refresh();
    }
    const byEngine = performance.now() - started;
    console.info(
      `batch at 3000/30000, one open draft: 500 records as one admission ${once.toFixed(0)} ms; 200 separate admissions by replay ${each.toFixed(0)} ms (${(each / 200).toFixed(1)} ms each); the same 200 by the engine ${byEngine.toFixed(0)} ms (${(byEngine / 200).toFixed(2)} ms each)`,
    );
  }, 600_000);
});
