import { decodeImportBlobMeta, type LoroDoc, VersionVector } from "loro-crdt";
import { decodeEnvelope, encodeEnvelope } from "./envelope.js";
import type { PeerId } from "./peer.js";
import type { DocKey } from "./shape.js";

/**
 * Versions as plain peer counters. A Loro `VersionVector` is WASM memory no garbage collector
 * reclaims, and a version is read on every batch sent, acked and received, so a handle that
 * escapes leaks for the life of the tab. Handles stay inside the functions here and in `RoomDocs`.
 */

/** One doc's version: each peer's op count (`VersionVector.toJSON()`). */
export type DocVersion = ReadonlyMap<PeerId, number>;

/** A room's version: each doc's version by doc key. */
export type RoomVersion = ReadonlyMap<DocKey, DocVersion>;

/** The oplog version of `doc`. */
export function docVersion(doc: LoroDoc): DocVersion {
  return plainVersion(doc.oplogVersion());
}

/** `vector` read out and freed. */
export function plainVersion(vector: VersionVector): DocVersion {
  try {
    return vector.toJSON();
  } finally {
    vector.free();
  }
}

/** Runs `use` with a Loro handle for `version`, freed after. */
export function withVector<T>(version: DocVersion, use: (vector: VersionVector) => T): T {
  const vector = new VersionVector(version as Map<PeerId, number>);
  try {
    return use(vector);
  } finally {
    vector.free();
  }
}

/** Whether `have` holds every op of `want`. */
export function docCovers(have: DocVersion | undefined, want: DocVersion): boolean {
  for (const [peer, counter] of want) if ((have?.get(peer) ?? 0) < counter) return false;
  return true;
}

/** Whether `have` holds every op of `want`, doc by doc. */
export function versionCovers(have: RoomVersion, want: RoomVersion): boolean {
  for (const [key, version] of want) if (!docCovers(have.get(key), version)) return false;
  return true;
}

/** `into` takes, per doc and peer, the larger counter of the two. */
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

/** The version a doc holds once `update` (a Loro update or snapshot) is imported, from its metadata. */
export function updateEnd(update: Uint8Array): DocVersion {
  const meta = decodeImportBlobMeta(update, false);
  meta.partialStartVersionVector.free();
  return plainVersion(meta.partialEndVersionVector);
}

/** A doc version as Loro encodes it, for a wire or a row. */
export function encodeDocVersion(version: DocVersion): Uint8Array {
  // Loro encodes peers in insertion order, so one version could encode two ways and hash to two
  // revisions; sorted, equal versions encode to equal bytes. `encodeRoomVersion` sorts doc keys too.
  const sorted = new Map([...version].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return withVector(sorted, (vector) => vector.encode());
}

export function decodeDocVersion(bytes: Uint8Array): DocVersion {
  return plainVersion(VersionVector.decode(bytes));
}

/** A room version as `JoinRequest`/`JoinResponseOk` carry it: an envelope of encoded vectors. */
export function encodeRoomVersion(version: RoomVersion): Uint8Array {
  const sorted = [...version].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return encodeEnvelope(new Map(sorted.map(([key, vv]) => [key, encodeDocVersion(vv)])));
}

export function decodeRoomVersion(bytes: Uint8Array): Map<DocKey, DocVersion> {
  if (bytes.length === 0) return new Map();
  return new Map([...decodeEnvelope(bytes)].map(([key, vv]) => [key, decodeDocVersion(vv)]));
}
