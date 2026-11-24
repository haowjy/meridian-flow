import type { Frontiers } from "loro-crdt";
import { inMap, scoped } from "./handles.js";
import { structureValues } from "./read.js";
import type { RoomDocs } from "./room-docs.js";
import { type BlockId, type DocKey, overrideMap } from "./shape.js";
import { isOrderKey, type Removal, removalOf, StructureView } from "./structure.js";
import { docCovers, docVersion } from "./version.js";
import { commitStructure, type DocChange, StructureWriter } from "./write.js";

/**
 * The commit origin of a local write no Ctrl+Z takes back: a restore, a removal written again, a
 * transaction marked `addToHistory: false`, or a write made outside the editor. The editor's Undo
 * history skips every commit under it.
 */
export const UNTRACKED_ORIGIN = "untracked";

/**
 * Bring removed blocks back (design §1, "Removed blocks"): `order[id]` set to the key its record
 * holds, last-writer-wins like any structure value, in a commit no Undo history records. A block
 * that is not removed, or was removed without a record (an older build's `null`), is left alone.
 * Returns the changes to publish.
 */
export function restore(docs: RoomDocs, ids: Iterable<BlockId>): DocChange[] {
  const view = new StructureView(docs);
  const before = docs.structure.frontiers();
  const writer = new StructureWriter(docs, view);
  for (const id of ids) {
    const removal = view.removal(id);
    if (removal) writer.set("order", id, removal.at);
  }
  const change = commitStructure(docs, before, { origin: UNTRACKED_ORIGIN });
  return change ? [change] : [];
}

/**
 * Rule 1 of "Removed blocks" (design §1): restore each removed block whose record did not count
 * an op, by any peer, that this copy holds in a text doc under it, of the removals the ops since
 * `before` brought (an import's, `before` taken just ahead of it) and of the removed blocks on the
 * path of each doc in `typed` (text an Undo put in), for that doc. A shown block in `moved` (one
 * an Undo moved) brings back every removed block on its path, as a move into a removed container
 * does anywhere. `RoomDocs.importBatch` and `forward` run it on every import, before anything
 * reads the copy, and an Undo over its own write (`putBackValues`). A draft's fork answers only
 * the removals in its own overrides. Returns the changes to publish.
 */
export function answerRemovals(
  docs: RoomDocs,
  before: Frontiers,
  { typed = [], moved = [] }: { typed?: Iterable<DocKey>; moved?: Iterable<BlockId> } = {},
): DocChange[] {
  const ids = new Set<BlockId>();
  const under = keysUnder(docs);
  const unread = (removal: Removal | null, keys: readonly DocKey[]) =>
    keys.some((key) => {
      const doc = docs.textOf(key);
      return doc !== undefined && !docCovers(removal?.seen.get(key), docVersion(doc));
    });
  for (const [id, removal] of removedSince(docs, before))
    if (unread(removal, under(id))) ids.add(id);
  let view: StructureView | undefined;
  for (const key of typed)
    for (const removed of removedOnPath(docs, key)) {
      view ??= new StructureView(docs);
      if (unread(view.removal(removed), [key])) ids.add(removed);
    }
  for (const id of moved) for (const removed of removedOnPath(docs, id)) ids.add(removed);
  return ids.size > 0 ? restore(docs, ids) : [];
}

/**
 * Every block id under a block (itself included) by the parents as read, shown or not: the text
 * docs a removal of it read. A textblock holds no blocks, so a removed paragraph costs no read of
 * the structure; it is read once, for the first container asked about.
 */
function keysUnder(docs: RoomDocs): (id: BlockId) => BlockId[] {
  const values = structureValues(docs);
  let view: StructureView | undefined;
  return (id) => {
    const node = values.value("node", id);
    if (typeof node === "string" && docs.shape.node(node)?.textblock) return [id];
    view ??= new StructureView(docs);
    return view.textKeysUnder(id);
  };
}

/**
 * The removed blocks on `id`'s path (itself and every block above it) that the editor can keep
 * on screen for its caret (design §1, "The caret rule"): empty when the path shows, or when a
 * block on it was removed without a record and cannot come back at a key.
 */
export function removedOnPath(docs: RoomDocs, id: BlockId): BlockId[] {
  const values = structureValues(docs);
  const out: BlockId[] = [];
  const seen = new Set<BlockId>();
  for (let at: unknown = id; typeof at === "string" && !seen.has(at); ) {
    seen.add(at);
    const order = values.value("order", at);
    if (order === undefined) return [];
    if (!isOrderKey(order)) {
      if (!removalOf(order)) return [];
      out.push(at);
    }
    at = values.value("parent", at);
  }
  return out;
}

/**
 * The blocks whose `order` the ops since `before` set and left as a removal record, with the
 * record: in the map this copy writes (a draft's `d.order`). Read from the ops, not from a diff of
 * states: a removal can arrive with the very record the block held already (a peer's Undo put it
 * back in its container, then the peer removed it again), and only its op says it came.
 */
function removedSince(docs: RoomDocs, before: Frontiers): [BlockId, Removal][] {
  const { structure } = docs;
  if (structure.cmpFrontiers(before, structure.frontiers()) === 0) return [];
  const map = docs.draft ? overrideMap("order") : "order";
  const container = `cid:root-${map}:Map`;
  const { changes } = scoped(structure.frontiersToVV(before), (from) =>
    structure.exportJsonUpdates(from, undefined, false),
  );
  const ids = new Set<BlockId>();
  for (const change of changes)
    for (const op of change.ops)
      if (op.container === container && op.content.type === "insert" && "key" in op.content)
        ids.add(op.content.key);
  if (ids.size === 0) return [];
  return inMap(structure, map, (orders) =>
    [...ids].flatMap((id): [BlockId, Removal][] => {
      const removal = removalOf(orders.get(id));
      return removal ? [[id, removal]] : [];
    }),
  );
}
