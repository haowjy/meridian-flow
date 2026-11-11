/** Plain tree_ops table: seq bigserial + jsonb record, no Y.Doc. */
import type { Database } from "@meridian/database";
import { sql } from "drizzle-orm";
import { lockDocumentMutation } from "../../../../shared/document-mutation-lock.js";
import {
  currentDrizzleDb,
  runInDrizzleTransaction,
} from "../../../../shared/drizzle-transaction.js";
import type { PocWorld } from "./harness.js";
import { syncProjection } from "./projection.js";
import {
  LIVE,
  settlementsOf,
  type Settlement,
  type TreeOp,
  TreeWriter,
  viewOps,
} from "./tree-log.js";
import * as Y from "yjs";

/**
 * In-memory log that mirrors tree_ops. Apply/discard still use a tiny Y.Doc for the
 * writer helper, then we flatten to records+settlements stored as jsonb rows.
 * Settlements are stored as a sidecar row type.
 */
export type StoredRecord =
  | { kind: "op"; op: TreeOp }
  | { kind: "settled"; id: string; settlement: Settlement };

export type OpsTreeStore = {
  doc: Y.Doc;
  writer: TreeWriter;
  persist: (mutator: () => void) => Promise<{ ms: number }>;
  loadOps: () => Promise<StoredRecord[]>;
};

export function createOpsTreeStore(world: PocWorld, doc?: Y.Doc): OpsTreeStore {
  const tree = doc ?? new Y.Doc({ gc: false });
  const writer = new TreeWriter(tree);

  async function persist(mutator: () => void): Promise<{ ms: number }> {
    const beforeOps = tree.getArray<TreeOp>("ops").toArray();
    const beforeSettled = new Map(settlementsOf(tree).entries());
    mutator();
    const afterOps = tree.getArray<TreeOp>("ops").toArray();
    const afterSettled = new Map(settlementsOf(tree).entries());
    const added: StoredRecord[] = [];
    for (const op of afterOps.slice(beforeOps.length)) added.push({ kind: "op", op });
    for (const [id, settlement] of afterSettled) {
      if (beforeSettled.get(id) !== settlement) added.push({ kind: "settled", id, settlement });
    }
    const t0 = performance.now();
    await runInDrizzleTransaction(world.db, async () => {
      const tx = currentDrizzleDb(world.db);
      await lockDocumentMutation(tx, `tree-ops:${world.sourceId}`);
      for (const record of added) {
        await tx.execute(
          sql`INSERT INTO tree_ops (record) VALUES (${JSON.stringify(record)}::jsonb)`,
        );
      }
      const stored = await loadOpsTx(tx);
      const merged = docFromRecords(stored);
      await syncProjection(world.db, merged, world.treeDocId, world.sourceId);
      merged.destroy();
    });
    return { ms: performance.now() - t0 };
  }

  async function loadOps(): Promise<StoredRecord[]> {
    return loadOpsTx(world.db);
  }

  return { doc: tree, writer, persist, loadOps };
}

export function replayStored(records: StoredRecord[]): {
  ops: TreeOp[];
  settled: Map<string, Settlement>;
} {
  const ops: TreeOp[] = [];
  const settled = new Map<string, Settlement>();
  for (const record of records) {
    if (record.kind === "op") ops.push(record.op);
    else settled.set(record.id, record.settlement);
  }
  return { ops, settled };
}

async function loadOpsTx(db: { execute: Database["execute"] }): Promise<StoredRecord[]> {
  const rows = (await db.execute(
    sql`SELECT record FROM tree_ops ORDER BY seq`,
  )) as unknown as Array<{ record: StoredRecord }>;
  return rows.map((row) => row.record);
}

export function docFromRecords(records: StoredRecord[]): Y.Doc {
  const { ops, settled } = replayStored(records);
  const doc = new Y.Doc({ gc: false });
  doc.transact(() => {
    if (ops.length) doc.getArray<TreeOp>("ops").push(ops);
    const map = settlementsOf(doc);
    for (const [id, settlement] of settled) map.set(id, settlement);
  });
  return doc;
}

export { viewOps, LIVE };
