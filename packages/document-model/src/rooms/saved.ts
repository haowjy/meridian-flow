import type { RoomDocs } from "../room-docs.js";
import { type DocKey, STRUCTURE_KEY } from "../shape.js";
import {
  type DocVersion,
  docCovers,
  docVersion,
  mergeVersion,
  type RoomVersion,
} from "../version.js";

// Read before `forward()`: what Live brings is in no row yet. A fork with no structure row starts
// from Live's structure, so it has saved what Live has.
export function savedAtLoad(
  docs: RoomDocs,
  rowKeys: Iterable<DocKey>,
  liveSaved: RoomVersion | null,
): Map<DocKey, DocVersion> {
  const saved = new Map<DocKey, DocVersion>();
  for (const key of rowKeys) {
    const doc = docs.doc(key);
    if (doc) saved.set(key, docVersion(doc));
  }
  const structure = liveSaved?.get(STRUCTURE_KEY);
  if (structure && !saved.has(STRUCTURE_KEY)) saved.set(STRUCTURE_KEY, structure);
  return saved;
}

export function advanceSaved(saved: Map<DocKey, DocVersion>, stored: RoomVersion): RoomVersion {
  const moved = new Map<DocKey, DocVersion>();
  for (const [key, at] of stored) if (!docCovers(saved.get(key), at)) moved.set(key, at);
  mergeVersion(saved, moved);
  for (const key of moved.keys()) moved.set(key, saved.get(key) ?? new Map());
  return moved;
}
