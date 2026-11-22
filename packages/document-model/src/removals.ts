import type { Frontiers } from "loro-crdt";
import { inMap, scoped } from "./handles.js";
import { structureValues } from "./read.js";
import type { RoomDocs } from "./room-docs.js";
import { type BlockId, overrideMap } from "./shape.js";
import { holdsUnread, isOrderKey, type Removal, removalOf, StructureView } from "./structure.js";
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
 * Returns the change to publish.
 */
export function restore(docs: RoomDocs, ids: Iterable<BlockId>): DocChange | null {
  const view = new StructureView(docs);
  const before = docs.structure.frontiers();
  const writer = new StructureWriter(docs, view);
  for (const id of ids) {
    const removal = view.removal(id);
    if (removal) writer.set("order", id, removal.at);
  }
  return commitStructure(docs, before, { origin: UNTRACKED_ORIGIN });
}

/**
 * Rule 1 of "Removed blocks" (design §1): of the removals the ops since `before` brought (an
 * import's, `before` taken just ahead of it), restore each whose record did not count an op, by
 * any peer, that this copy holds in a text doc under the block. Run it after every import that
 * changed the structure and before any reader, on every copy that imports: each tab and the
 * server's room copy. A draft's fork answers only the removals in its own overrides. Returns the
 * change to publish.
 */
export function answerRemovals(docs: RoomDocs, before: Frontiers): DocChange | null {
  const removed = removedSince(docs, before);
  if (removed.length === 0) return null;
  const under = keysUnder(docs);
  const unread = removed.filter(([id, removal]) =>
    under(id).some((key) => {
      const doc = docs.textOf(key);
      return doc !== undefined && holdsUnread(doc, removal.seen[key]);
    }),
  );
  return unread.length > 0
    ? restore(
        docs,
        unread.map(([id]) => id),
      )
    : null;
}

/**
 * Every block id under a block (itself included) by the parents as stored, shown or not: the text
 * docs a removal of it read. A textblock holds no blocks, so a removed paragraph costs no scan;
 * the parents are indexed once, for the first container asked about.
 */
function keysUnder(docs: RoomDocs): (id: BlockId) => BlockId[] {
  const values = structureValues(docs);
  let below: Map<BlockId, BlockId[]> | undefined;
  const index = () => {
    const parents: Record<BlockId, unknown> = inMap(docs.structure, "parent", (map) =>
      map.toJSON(),
    );
    if (docs.draft)
      Object.assign(
        parents,
        inMap(docs.structure, overrideMap("parent"), (map) => map.toJSON()),
      );
    const out = new Map<BlockId, BlockId[]>();
    for (const [child, parent] of Object.entries(parents)) {
      if (typeof parent !== "string") continue;
      const list = out.get(parent);
      if (list) list.push(child);
      else out.set(parent, [child]);
    }
    return out;
  };
  return (id) => {
    const out: BlockId[] = [];
    const walk = (at: BlockId) => {
      if (out.includes(at)) return;
      out.push(at);
      const node = values.value("node", at);
      if (typeof node === "string" && docs.shape.node(node)?.textblock) return;
      below ??= index();
      for (const child of below.get(at) ?? []) walk(child);
    };
    walk(id);
    return out;
  };
}

/**
 * After an Undo or Redo that changed the structure doc: write again, with what this copy reads
 * now, every removal record the run's ops (since `before`) left in `order`. Loro replays the value
 * it stored, which says what the first removal read; a peer that typed since would answer it with
 * a restore and the Redo would not land. Publish the change in one batch with the run's.
 */
export function restampRemovals(docs: RoomDocs, before: Frontiers): DocChange | null {
  const removed = removedSince(docs, before);
  if (removed.length === 0) return null;
  const at = docs.structure.frontiers();
  const writer = new StructureWriter(docs, new StructureView(docs));
  for (const [id, removal] of removed) writer.remove(id, removal.at);
  return commitStructure(docs, at, { origin: UNTRACKED_ORIGIN });
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
