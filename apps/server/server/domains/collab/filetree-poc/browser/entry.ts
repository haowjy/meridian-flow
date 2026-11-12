/** Proof code. The replay's cost in a browser: built here, run by run-browser.mjs in Chromium. */
import * as Y from "yjs";
import { LIVE, opsOf, replay, ROOT, type TreeOp, viewOps } from "../tree-log.js";

function build(nodes: number, records: number) {
  const doc = new Y.Doc({ gc: false });
  const batch: TreeOp[] = [];
  const folders = [ROOT];
  const ids: string[] = [];
  let n = 0;
  const uuid = (i: number) => `${i.toString(16).padStart(8, "0")}-0000-4000-8000-${(i * 7919).toString(16).padStart(12, "0")}`;
  const rank = () => `a${(n += 1).toString(36).padStart(7, "0")}`;
  const add = (draft: string | null, input: Record<string, unknown>) =>
    batch.push({ ...input, id: uuid(1_000_000 + batch.length), actor: "user:w", draft } as unknown as TreeOp);
  for (let i = 0; i < nodes; i += 1) {
    const folder = i % 20 === 0;
    add(null, { type: "create", node: uuid(i), kind: folder ? "folder" : "document", name: `Chapter ${i}`, parent: folders[(i * 7) % folders.length], rank: rank() });
    ids.push(uuid(i));
    if (folder) folders.push(uuid(i));
  }
  const isFolder = new Set(folders);
  for (let i = 0; batch.length < records; i += 1) {
    const node = ids[(i * 13) % ids.length] as string;
    if (i % 3 === 0 || isFolder.has(node)) add(null, { type: "rename", node, name: `Chapter ${i}: renamed`, fromName: "x" });
    else add(null, { type: "move", node, parent: folders[i % folders.length], rank: rank(), from: { parent: ROOT, rank: "a" } });
  }
  for (let i = 0; i < 150; i += 1) {
    const node = ids[(i * 17) % ids.length] as string;
    if (i % 3 === 0) add("w1", { type: "create", node: uuid(900_000 + i), kind: "document", name: `Draft ${i}`, parent: folders[i % folders.length], rank: rank() });
    else if (i % 3 === 1 || isFolder.has(node)) add("w1", { type: "rename", node, name: `Drafted ${i}`, fromName: "x" });
    else add("w1", { type: "move", node, parent: folders[(i + 3) % folders.length], rank: rank(), from: { parent: ROOT, rank: "a" } });
  }
  for (let at = 0; at < batch.length; at += 1000) opsOf(doc).push(batch.slice(at, at + 1000));
  return doc;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] as number;

export function run(nodes: number, records: number) {
  const doc = build(nodes, records);
  const update = Y.encodeStateAsUpdate(doc);
  const load: number[] = [];
  const live: number[] = [];
  const draft: number[] = [];
  let loaded = doc;
  for (let i = 0; i < 9; i += 1) {
    let at = performance.now();
    loaded = new Y.Doc({ gc: false });
    Y.applyUpdate(loaded, update);
    load.push(performance.now() - at);
    at = performance.now();
    const tree = replay(viewOps(loaded, LIVE));
    live.push(performance.now() - at);
    at = performance.now();
    replay(viewOps(loaded, { draft: "w1" }), { draft: "w1" });
    draft.push(performance.now() - at);
    if (tree.nodes.size < nodes) throw new Error("short tree");
  }
  return {
    nodes,
    records,
    bytes: update.byteLength,
    loadMs: +median(load).toFixed(1),
    replayLiveMs: +median(live).toFixed(1),
    replayDraftMs: +median(draft).toFixed(1),
  };
}

(globalThis as unknown as { treeBench: typeof run }).treeBench = run;
