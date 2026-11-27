import { documentSnapshots, type StoredFrontiers } from "@meridian/database/schema";
import { type DocVersion, docVersion } from "@meridian/document-model";
import { sql } from "drizzle-orm";
import type { LoroDoc, PeerID } from "loro-crdt";
import type { DrizzleDb } from "./drizzle-transaction.js";

export type SnapshotRow = { roomKey: string; docKey: string; doc: LoroDoc };

// Each doc's version is read at its export: a room imports into its docs without a lock, so a
// version read after the insert's awaits can cover a batch the row lacks.
export async function writeSnapshots(
  tx: DrizzleDb,
  rows: readonly SnapshotRow[],
): Promise<{ bytes: number; stored: Map<string, DocVersion> }> {
  const stored = new Map<string, DocVersion>();
  if (rows.length === 0) return { bytes: 0, stored };
  const values = rows.map(({ roomKey, docKey, doc }) => {
    stored.set(docKey, docVersion(doc));
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
  return { bytes: values.reduce((sum, value) => sum + value.snapshot.byteLength, 0), stored };
}

export const storedFrontiers = (doc: LoroDoc): StoredFrontiers =>
  doc.frontiers().map(({ peer, counter }) => ({ peer, counter }));

export const loroFrontiers = (frontiers: StoredFrontiers) =>
  frontiers.map(({ peer, counter }) => ({ peer: peer as PeerID, counter }));

// `frontiersToVV` throws for a peer id the doc lacks (loro-crdt 1.18, though its changelog says it returns undefined)
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
