import type { DocKey } from "../shape.js";
import {
  type DocVersion,
  docCovers,
  encodeRoomVersion,
  mergeVersion,
  type RoomVersion,
} from "../version.js";

export function savedLag(version: RoomVersion, saved: RoomVersion): Uint8Array {
  const lagging = new Map<DocKey, DocVersion>();
  for (const [key, at] of version)
    if (!docCovers(saved.get(key), at)) lagging.set(key, saved.get(key) ?? new Map());
  return encodeRoomVersion(lagging);
}

export function advanceSaved(saved: Map<DocKey, DocVersion>, stored: RoomVersion): RoomVersion {
  const moved = new Map<DocKey, DocVersion>();
  for (const [key, at] of stored) if (!docCovers(saved.get(key), at)) moved.set(key, at);
  mergeVersion(saved, moved);
  for (const key of moved.keys()) moved.set(key, saved.get(key) ?? new Map());
  return moved;
}
