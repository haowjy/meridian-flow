import { documentSnapshots, type StoredFrontiers } from "@meridian/database/schema";
import { sql } from "drizzle-orm";
import type { LoroDoc, PeerID } from "loro-crdt";
import type { DrizzleDb } from "./drizzle-transaction.js";

export type SnapshotRow = { roomKey: string; docKey: string; doc: LoroDoc };

export async function writeSnapshots(tx: DrizzleDb, rows: readonly SnapshotRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values = rows.map(({ roomKey, docKey, doc }) => {
    const snapshot = doc.export({ mode: "snapshot" });
    return {
      roomKey,
      docKey,
      snapshot: Buffer.from(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength),
      frontiers: storedFrontiers(doc),
      historyMark: storedFrontiers(doc),
    };
  });
  await tx
    .insert(documentSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: [documentSnapshots.roomKey, documentSnapshots.docKey],
      set: {
        snapshot: sql`excluded.snapshot`,
        frontiers: sql`excluded.frontiers`,
        savedAt: sql`now()`,
      },
    });
  return values.reduce((sum, value) => sum + value.snapshot.byteLength, 0);
}

export const storedFrontiers = (doc: LoroDoc): StoredFrontiers =>
  doc.frontiers().map(({ peer, counter }) => ({ peer, counter }));

export const loroFrontiers = (frontiers: StoredFrontiers) =>
  frontiers.map(({ peer, counter }) => ({ peer: peer as PeerID, counter }));

// keep: `frontiersToVV` throws for a peer id the doc lacks (loro-crdt 1.18, though its changelog says it returns undefined)
export function holdsFrontiers(doc: LoroDoc | undefined, frontiers: StoredFrontiers): boolean {
  if (!doc) return false;
  try {
    const vector = doc.frontiersToVV(loroFrontiers(frontiers));
    vector?.free();
    return vector !== undefined;
  } catch {
    return false;
  }
}

export function sameFrontiers(a: StoredFrontiers, b: StoredFrontiers): boolean {
  return (
    a.length === b.length &&
    a.every(({ peer, counter }) => b.some((id) => id.peer === peer && id.counter === counter))
  );
}
