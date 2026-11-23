import { Groups } from "./groups.js";
import { inMap } from "./handles.js";
import type { RoomDocs } from "./room-docs.js";
import { type BlockId, overrideMap, pieceEnds } from "./shape.js";

/** The blocks the `pieces` records connect, one group per connected component. */
export function linkedPieces(keys: Iterable<string>): Groups {
  const linked = new Groups([]);
  for (const key of keys) {
    const [a, b] = pieceEnds(key);
    linked.add(a);
    linked.add(b);
    linked.join(a, b);
  }
  return linked;
}

/**
 * The `d.pieces` records of each connected component holding one of `blocks`, each with the block
 * of `blocks` in its component: a press deletes them with the change it presses.
 */
export function piecesOf(docs: RoomDocs, blocks: Iterable<BlockId>): Map<string, BlockId> {
  const out = new Map<string, BlockId>();
  const keys = inMap(docs.structure, overrideMap("pieces"), (map) => map.keys());
  if (keys.length === 0) return out;
  const linked = linkedPieces(keys);
  const owner = new Map<BlockId, BlockId>();
  for (const id of blocks)
    if (linked.has(id) && !owner.has(linked.find(id))) owner.set(linked.find(id), id);
  for (const key of keys) {
    const by = owner.get(linked.find(pieceEnds(key)[0]));
    if (by !== undefined) out.set(key, by);
  }
  return out;
}
