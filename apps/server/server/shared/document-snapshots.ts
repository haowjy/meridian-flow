import { documentSnapshots, type StoredFrontiers } from "@meridian/database/schema";
import { sql } from "drizzle-orm";
import type { LoroDoc, PeerID } from "loro-crdt";
import type { DrizzleDb } from "./drizzle-transaction.js";

/** One doc's row of `document_snapshots`, as a save writes it. */
export type SnapshotRow = { roomKey: string; docKey: string; doc: LoroDoc };

/** Upserts each doc's snapshot and frontiers; returns the bytes written. */
export async function writeSnapshots(tx: DrizzleDb, rows: readonly SnapshotRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const values = rows.map(({ roomKey, docKey, doc }) => {
    const snapshot = doc.export({ mode: "snapshot" });
    return {
      roomKey,
      docKey,
      snapshot: Buffer.from(snapshot.buffer, snapshot.byteOffset, snapshot.byteLength),
      frontiers: doc.frontiers().map(({ peer, counter }) => ({ peer, counter })),
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

/**
 * Whether `doc` has every op `frontiers` names. `frontiersToVV` throws for an id the doc lacks
 * (loro-crdt 1.18, though its changelog says it returns undefined).
 */
export function holdsFrontiers(doc: LoroDoc | undefined, frontiers: StoredFrontiers): boolean {
  if (!doc) return false;
  try {
    return (
      doc.frontiersToVV(
        frontiers.map(({ peer, counter }) => ({ peer: peer as PeerID, counter })),
      ) !== undefined
    );
  } catch {
    return false;
  }
}
