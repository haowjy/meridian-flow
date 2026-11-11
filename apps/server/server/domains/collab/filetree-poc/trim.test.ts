/** Proof code. A trim leaves live and every Work's view as they were, at small and serial size. */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  descendantsOf,
  fingerprint,
  LIVE,
  materialize,
  opsOf,
  ROOT,
  type TreeOp,
  TreeWriter,
  treeViolations,
  type View,
} from "./tree-log.js";
import { trimTree } from "./trim.js";

const VIEWS: View[] = [LIVE, { draft: "w1" }, { draft: "w2" }];
const NAMES = ["Notes", "Ch1", "Ch2", "Arc", "Map"];

export function rngForDebug(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** One random step in a random view; the same seed gives the same steps on equal trees. */
export function stepForDebug(writer: TreeWriter, random: () => number, tag: string) {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const view = pick(VIEWS);
  const projection = materialize(writer.doc, view);
  const shown = [...projection.nodes.values()]
    .filter((node) => !node.trashed && node.id !== ROOT)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const folders = [ROOT, ...shown.filter((node) => node.kind === "folder").map((node) => node.id)];
  const roll = random();
  if (roll < 0.35 || shown.length === 0)
    writer.create(view, "user:w", {
      kind: random() < 0.35 ? "folder" : "document",
      name: pick(NAMES),
      parent: pick(folders),
      index: Math.floor(random() * 4),
      node: `${tag}-${Math.floor(random() * 1e9)}`,
    });
  else if (roll < 0.6) {
    const node = pick(shown);
    const inside = new Set([node.id, ...descendantsOf(projection, node.id)]);
    const targets = folders.filter((folder) => !inside.has(folder));
    if (targets.length > 0) writer.move(view, "agent:c/t", node.id, pick(targets), Math.floor(random() * 4));
  } else if (roll < 0.72) writer.rename(view, "user:w", pick(shown).id, pick(NAMES));
  else if (roll < 0.88) writer.delete(view, "user:w", pick(shown).id);
  else {
    const trashed = [...projection.nodes.values()].filter((node) => node.trashed).sort((a, b) => (a.id < b.id ? -1 : 1));
    if (trashed.length > 0) writer.restore(view, "user:w", pick(trashed).id);
  }
}

describe("trimming the list", () => {
  it("leaves live and both Works' views as they were, and the trimmed list behaves the same afterwards, over 200 histories", () => {
    let kept = 0;
    let numbered = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const doc = new Y.Doc({ gc: false });
      const writer = new TreeWriter(doc);
      const random = rngForDebug(seed);
      for (let i = 0; i < 120; i += 1) stepForDebug(writer, random, `a${i}`);
      const trimmed = trimTree(doc);
      for (const view of VIEWS) {
        const before = materialize(doc, view);
        expect(fingerprint(materialize(trimmed, view)), `seed ${seed} ${view.draft ?? "live"}`).toBe(
          fingerprint(before),
        );
        expect(treeViolations(materialize(trimmed, view))).toEqual([]);
        kept += [...before.nodes.values()].filter((node) => node.keptByChild).length;
        numbered += [...before.nodes.values()].filter((node) => node.displayName !== node.name).length;
      }
      // The same further steps on both give the same trees.
      const [a, b] = [rngForDebug(seed + 7919), rngForDebug(seed + 7919)];
      const after = new TreeWriter(trimmed);
      for (let i = 0; i < 40; i += 1) {
        stepForDebug(writer, a, `b${i}`);
        stepForDebug(after, b, `b${i}`);
      }
      for (const view of VIEWS)
        expect(fingerprint(materialize(trimmed, view), false), `seed ${seed} after`).toBe(
          fingerprint(materialize(doc, view), false),
        );
    }
    expect(kept).toBeGreaterThan(0);
    expect(numbered).toBeGreaterThan(0);
    console.info(`trim: 200 histories, ${kept} kept folders and ${numbered} numbered names carried across`);
  }, 600_000);

  it("at a serial's size: 3,000 nodes, 30,000 records, two drafts", () => {
    const doc = new Y.Doc({ gc: false });
    const batch: TreeOp[] = [];
    const folders = [ROOT];
    const ids: string[] = [];
    let n = 0;
    const rank = () => `a${(n += 1).toString(36).padStart(6, "0")}`;
    const add = (draft: string | null, input: Record<string, unknown>) =>
      batch.push({ ...input, id: `g${batch.length}`, actor: "user:w", draft } as unknown as TreeOp);
    for (let i = 0; i < 3000; i += 1) {
      const folder = i % 20 === 0;
      add(null, { type: "create", node: `n${i}`, kind: folder ? "folder" : "document", name: NAMES[i % 5], parent: folders[(i * 7) % folders.length], rank: rank() });
      ids.push(`n${i}`);
      if (folder) folders.push(`n${i}`);
    }
    const isFolder = new Set(folders);
    for (let i = 0; batch.length < 30000; i += 1) {
      const node = ids[(i * 13) % ids.length] as string;
      if (i % 5 === 0) add(null, { type: "rename", node, name: NAMES[i % 5], fromName: "x" });
      else if (i % 97 === 0) add(null, { type: "delete", node, cascade: [] });
      else if (!isFolder.has(node)) add(null, { type: "move", node, parent: folders[i % folders.length], rank: rank(), from: { parent: ROOT, rank: "a" } });
      else add(null, { type: "rename", node, name: `F${i}`, fromName: "x" });
    }
    for (const draft of ["w1", "w2"])
      for (let i = 0; i < 150; i += 1) {
        const node = ids[(i * 17 + draft.length) % ids.length] as string;
        if (i % 3 === 0) add(draft, { type: "create", node: `${draft}-${i}`, kind: "document", name: NAMES[i % 5], parent: folders[i % folders.length], rank: rank() });
        else if (i % 3 === 1) add(draft, { type: "rename", node, name: NAMES[(i + 1) % 5], fromName: "x" });
        else if (!isFolder.has(node)) add(draft, { type: "move", node, parent: folders[(i + 3) % folders.length], rank: rank(), from: { parent: ROOT, rank: "a" } });
      }
    for (let at = 0; at < batch.length; at += 1000) opsOf(doc).push(batch.slice(at, at + 1000));
    const started = performance.now();
    const trimmed = trimTree(doc);
    const took = performance.now() - started;
    for (const view of VIEWS)
      expect(fingerprint(materialize(trimmed, view))).toBe(fingerprint(materialize(doc, view)));
    const size = (d: Y.Doc) => Y.encodeStateAsUpdate(d).byteLength;
    console.info(
      `trim at size: ${opsOf(doc).length} records to ${opsOf(trimmed).length}, ${(size(doc) / 1048576).toFixed(2)} MiB to ${(size(trimmed) / 1048576).toFixed(2)} MiB, in ${took.toFixed(0)} ms`,
    );
  }, 600_000);
});
