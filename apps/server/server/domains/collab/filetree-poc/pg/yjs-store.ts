/** Production journal + projection in one transaction. */
import type { Database } from "@meridian/database";
import * as Y from "yjs";
import { createDrizzleJournal } from "../../adapters/drizzle-journal.js";
import { runInDrizzleTransaction } from "../../../../shared/drizzle-transaction.js";
import type { PocWorld } from "./harness.js";
import { syncProjection } from "./projection.js";
import { TreeWriter } from "./tree-log.js";

export function docFromSnapshot(snapshot: {
  checkpoint: Uint8Array | null;
  updates: Array<{ update: Uint8Array }>;
}): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  if (snapshot.checkpoint) Y.applyUpdate(doc, snapshot.checkpoint);
  for (const row of snapshot.updates) Y.applyUpdate(doc, row.update);
  return doc;
}

export type YjsTreeStore = {
  doc: Y.Doc;
  writer: TreeWriter;
  persist: (mutator: () => void, opts?: { projectFromMemory?: boolean }) => Promise<{ ms: number }>;
  reload: () => Promise<Y.Doc>;
};

export async function openYjsTreeStore(world: PocWorld): Promise<YjsTreeStore> {
  const snapshot = await world.journal.read(world.treeDocId);
  const doc = docFromSnapshot(snapshot);
  if (doc.clientID < 1000) doc.clientID = 10_000 + Math.floor(Math.random() * 10_000);
  return createYjsTreeStore(world, doc);
}

export function createYjsTreeStore(world: PocWorld, doc?: Y.Doc): YjsTreeStore {
  const tree = doc ?? new Y.Doc({ gc: false });
  if (tree.clientID < 1000) tree.clientID = 10_000 + (tree.clientID % 10_000);
  const writer = new TreeWriter(tree);
  const journal = world.journal;

  async function persist(
    mutator: () => void,
    opts?: { projectFromMemory?: boolean },
  ): Promise<{ ms: number }> {
    const before = Y.encodeStateVector(tree);
    mutator();
    const update = Y.encodeStateAsUpdate(tree, before);
    const t0 = performance.now();
    await runInDrizzleTransaction(world.db, async () => {
      await journal.append(world.treeDocId, update, { origin: "system" });
      if (opts?.projectFromMemory) {
        await syncProjection(world.db, tree, world.treeDocId, world.sourceId);
        return;
      }
      const snapshot = await journal.read(world.treeDocId);
      const merged = docFromSnapshot(snapshot);
      await syncProjection(world.db, merged, world.treeDocId, world.sourceId);
      merged.destroy();
    });
    return { ms: performance.now() - t0 };
  }

  async function reload(): Promise<Y.Doc> {
    const snapshot = await journal.read(world.treeDocId);
    return docFromSnapshot(snapshot);
  }

  return { doc: tree, writer, persist, reload };
}

export async function loadTreeDoc(db: Database, treeDocId: string): Promise<Y.Doc> {
  const journal = createDrizzleJournal(db);
  return docFromSnapshot(await journal.read(treeDocId));
}
