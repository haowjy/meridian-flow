import { Groups } from "./groups.js";
import { inMap, inText } from "./handles.js";
import type { RoomDocs } from "./room-docs.js";
import { type BlockId, overrideMap, pieceEnds } from "./shape.js";
import { blockPending, Side } from "./side.js";

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
 * of `blocks` in its component. A press deletes them all: every changed block of such a component
 * is in the change it settles.
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

export function deletePieces(docs: RoomDocs, keys: Iterable<string>): void {
  inMap(docs.structure, overrideMap("pieces"), (map) => {
    for (const key of keys) map.delete(key);
  });
}

/**
 * Delete the records of each component `piecesOf(docs, touched)` finds that holds no block review
 * lists as changed (design §2). Run inside the write that may have settled them, so its Undo puts
 * them back with it: such a component recorded a move that is gone, and a later edit of its blocks
 * is its own change. `pending` names blocks the caller already knows are changed, so a component
 * holding one is kept without reading the structure. The records the write itself made (`made`)
 * stay: a press on another copy can make the move pending again before this write reaches it (a
 * tab joins back a split the server is applying), and only the write's own record ties its halves
 * then. The next write that finds the component settled retires it.
 */
export function retirePieces(
  docs: RoomDocs,
  touched: Iterable<BlockId>,
  pending: (id: BlockId) => boolean = () => false,
  made: ReadonlySet<string> = new Set(),
): void {
  const live = docs.live;
  const found = live ? piecesOf(docs, touched) : new Map<string, BlockId>();
  if (!live || found.size === 0) return;
  const members = new Map<BlockId, Set<BlockId>>();
  for (const [key, by] of found) {
    const into = members.get(by) ?? new Set<BlockId>();
    for (const id of pieceEnds(key)) into.add(id);
    members.set(by, into);
  }
  const open = [...members].filter(([, ids]) => ![...ids].some(pending));
  if (open.length === 0) return;
  const [L, F] = [new Side(live), new Side(docs)];
  const settled = new Set(
    open.filter(([, ids]) => ![...ids].some((id) => blockPending(L, F, id))).map(([by]) => by),
  );
  if (settled.size > 0)
    deletePieces(
      docs,
      [...found].filter(([key, by]) => settled.has(by) && !made.has(key)).map(([key]) => key),
    );
}

/** Whether a draft's text of block `id` differs from Live's, character for character. */
export function textDiffers(docs: RoomDocs, id: BlockId): boolean {
  const plain = (doc: ReturnType<RoomDocs["textOf"]>) =>
    doc ? inText(doc, (text) => text.toString()) : "";
  return plain(docs.textOf(id)) !== plain(docs.live?.textOf(id));
}
