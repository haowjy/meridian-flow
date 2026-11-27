import { decodeImportBlobMeta, type LoroDoc, VersionVector } from "loro-crdt";
import { decodeEnvelope, encodeEnvelope } from "./envelope.js";
import type { PeerId } from "./peer.js";
import type { DocKey } from "./shape.js";

/**
 * Versions as plain peer counters. A Loro `VersionVector` is WASM memory no garbage collector
 * reclaims, and a version is read on every batch sent, acked and received, so a handle that
 * escapes leaks for the life of the tab. Handles stay inside the functions here and in `RoomDocs`.
 */

export type DocVersion = ReadonlyMap<PeerId, number>;

export type RoomVersion = ReadonlyMap<DocKey, DocVersion>;

export function docVersion(doc: LoroDoc): DocVersion {
  return plainVersion(doc.oplogVersion());
}

export function plainVersion(vector: VersionVector): DocVersion {
  try {
    return vector.toJSON();
  } finally {
    vector.free();
  }
}

export function withVector<T>(version: DocVersion, use: (vector: VersionVector) => T): T {
  const vector = new VersionVector(version as Map<PeerId, number>);
  try {
    return use(vector);
  } finally {
    vector.free();
  }
}

export function docCovers(have: DocVersion | undefined, want: DocVersion): boolean {
  for (const [peer, counter] of want) if ((have?.get(peer) ?? 0) < counter) return false;
  return true;
}

export function versionCovers(have: RoomVersion, want: RoomVersion): boolean {
  for (const [key, version] of want) if (!docCovers(have.get(key), version)) return false;
  return true;
}

export function mergeVersion(into: Map<DocKey, DocVersion>, from: RoomVersion): void {
  for (const [key, version] of from) {
    const have = into.get(key);
    if (!have) into.set(key, version);
    else if (!docCovers(have, version)) {
      const merged = new Map(have);
      for (const [peer, counter] of version)
        if ((merged.get(peer) ?? 0) < counter) merged.set(peer, counter);
      into.set(key, merged);
    }
  }
}

export function updateEnd(update: Uint8Array): DocVersion {
  const meta = decodeImportBlobMeta(update, false);
  meta.partialStartVersionVector.free();
  return plainVersion(meta.partialEndVersionVector);
}

export function batchEnd(batch: Uint8Array): RoomVersion {
  return new Map([...decodeEnvelope(batch)].map(([key, bytes]) => [key, updateEnd(bytes)]));
}

export function encodeDocVersion(version: DocVersion): Uint8Array {
  // Loro encodes peers in insertion order, so one version could encode two ways and hash to two
  // revisions; sorted, equal versions encode to equal bytes. `encodeRoomVersion` sorts doc keys too.
  const sorted = new Map([...version].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return withVector(sorted, (vector) => vector.encode());
}

export function decodeDocVersion(bytes: Uint8Array): DocVersion {
  return plainVersion(VersionVector.decode(bytes));
}

export function encodeRoomVersion(version: RoomVersion): Uint8Array {
  const sorted = [...version].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return encodeEnvelope(new Map(sorted.map(([key, vv]) => [key, encodeDocVersion(vv)])));
}

export function decodeRoomVersion(bytes: Uint8Array): Map<DocKey, DocVersion> {
  if (bytes.length === 0) return new Map();
  return new Map([...decodeEnvelope(bytes)].map(([key, vv]) => [key, decodeDocVersion(vv)]));
}
