/**
 * Proof code. The processor cost of admitting one record the way the design says: the server
 * keeps the list and each view's last replay in memory, appends, replays live and each open
 * draft once, and compares with the replay it kept. No database: the journal insert and the
 * row writes are measured in pg/run.ts.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  LIVE,
  materialize,
  ROOT,
  type TreeOp,
  type TreeProjection,
  TreeWriter,
  treeViolations,
} from "./tree-log.js";

function build(nodes: number, records: number, drafts: string[], perDraft: number) {
  const doc = new Y.Doc({ gc: false });
  const w = new TreeWriter(doc);
  const folders = [ROOT];
  const ids: string[] = [];
  const rank = (i: number) => `a${i.toString(36).padStart(6, "0")}`;
  let n = 0;
  // Records are built in plain arrays and pushed a thousand at a time: one push per record
  // inside a single Yjs transaction is quadratic.
  const batch: TreeOp[] = [];
  let made = 0;
  const add = (draft: string | null, actor: string, input: Record<string, unknown>) => {
    made += 1;
    batch.push({ ...input, id: `b${made}`, actor, draft } as unknown as TreeOp);
    if (batch.length >= 1000) doc.getArray<TreeOp>("ops").push(batch.splice(0));
  };
  for (let i = 0; i < nodes; i += 1) {
    const folder = i % 20 === 0;
    const parent = folders[(i * 7) % folders.length] as string;
    add(null, "user:w", { type: "create", node: `n${i}`, kind: folder ? "folder" : "document", name: `N${i}`, parent, rank: rank(n++) });
    ids.push(`n${i}`);
    if (folder && folders.length < nodes / 20) folders.push(`n${i}`);
  }
  const isFolder = new Set(folders);
  for (let i = 0; made < records; i += 1) {
    const node = ids[(i * 13) % ids.length] as string;
    if (i % 3 === 0 || isFolder.has(node)) add(null, "user:w", { type: "rename", node, name: `R${i}`, fromName: "x" });
    else add(null, i % 2 ? "agent:c/t" : "user:w", { type: "move", node, parent: folders[i % folders.length] as string, rank: rank(n++), from: { parent: ROOT, rank: "a" } });
  }
  for (const draft of drafts)
    for (let i = 0; i < perDraft; i += 1) {
      const node = ids[(i * 17 + draft.length) % ids.length] as string;
      if (i % 4 === 0) add(draft, "agent:c/t", { type: "create", node: `${draft}-${i}`, kind: i % 8 === 0 ? "folder" : "document", name: `D${i}`, parent: folders[i % folders.length] as string, rank: rank(n++) });
      else if (i % 4 === 1 || isFolder.has(node)) add(draft, "agent:c/t", { type: "rename", node, name: `DR${i}`, fromName: "x" });
      else add(draft, "agent:c/t", { type: "move", node, parent: folders[(i + 3) % folders.length] as string, rank: rank(n++), from: { parent: ROOT, rank: "a" } });
    }
  doc.getArray<TreeOp>("ops").push(batch.splice(0));
  return { doc, w, ids, folders, rank: () => rank(n++) };
}

function changed(before: TreeProjection, after: TreeProjection): number {
  let count = 0;
  for (const [id, node] of after.nodes) {
    const was = before.nodes.get(id);
    if (!was || was.parent !== node.parent || was.displayName !== node.displayName || was.rank !== node.rank || was.trashed !== node.trashed) count += 1;
  }
  return count;
}

function measure(nodes: number, records: number, draftCount: number) {
  const drafts = ["w1", "w2", "w3"].slice(0, draftCount);
  const t = build(nodes, records, drafts, 150);
  const views = [LIVE, ...drafts.map((draft) => ({ draft }))];
  let kept = views.map((view) => materialize(t.doc, view));
  expect(treeViolations(kept[0] as TreeProjection)).toEqual([]);
  const times: number[] = [];
  let rows = 0;
  for (let i = 0; i < 60; i += 1) {
    const node = t.ids[(i * 31 + 5) % t.ids.length] as string;
    const started = performance.now();
    if (i % 3 === 0) t.w.author(LIVE, "user:w", { type: "rename", node, name: `Z${i}`, fromName: "x" });
    else if (i % 3 === 1) t.w.author(LIVE, "user:w", { type: "create", node: `new${nodes}-${draftCount}-${i}`, kind: "document", name: `New${i}`, parent: t.folders[i % t.folders.length] as string, rank: t.rank() });
    else if (!t.folders.includes(node)) t.w.author(LIVE, "user:w", { type: "move", node, parent: t.folders[(i + 1) % t.folders.length] as string, rank: t.rank(), from: { parent: ROOT, rank: "a" } });
    const next = views.map((view) => materialize(t.doc, view));
    for (const [at, projection] of next.entries()) rows += changed(kept[at] as TreeProjection, projection);
    kept = next;
    times.push(performance.now() - started);
  }
  times.sort((a, b) => a - b);
  const replayStart = performance.now();
  materialize(t.doc, LIVE);
  const replay = performance.now() - replayStart;
  return { median: times[Math.floor(times.length / 2)] as number, worst: times.at(-1) as number, replay, rowsPerOp: rows / 60, bytes: Y.encodeStateAsUpdate(t.doc).byteLength };
}

describe("cost of admitting one record with the replays kept in memory", () => {
  for (const [nodes, records] of [[3_000, 30_000], [10_000, 100_000]] as const)
    for (const drafts of [0, 1, 3])
      it(`${nodes} nodes, ${records} records, ${drafts} open drafts`, () => {
        const r = measure(nodes, records, drafts);
        console.info(
          `admit ${nodes}/${records} drafts=${drafts}: median ${r.median.toFixed(1)} ms, worst ${r.worst.toFixed(1)} ms; one replay of live ${r.replay.toFixed(1)} ms; rows changed per record ${r.rowsPerOp.toFixed(1)}; doc ${(r.bytes / 1024 / 1024).toFixed(2)} MiB`,
        );
      }, 600_000);
});
