/**
 * Observation frontiers: what document state a model was shown. A frontier is
 * a Yjs snapshot of the document a result was rendered from plus the blocks
 * that changed since the model's previous frontier and that this result did not
 * show in full ("unshown"). Pure Yjs; the host keys and stores frontiers.
 */
import * as Y from "yjs";
import { getBlockItemId, getTopLevelXmlBlocks } from "./model/block-hash.js";
import { PROSEMIRROR_FRAGMENT_NAME } from "./model/prosemirror-fragment.js";

export interface ObservationFrontier {
  /** `Y.encodeSnapshotV2` of the document the result was rendered from. */
  snapshot: Uint8Array;
  /** Block ids (`client:clock` of the top-level item), in document order. */
  unshown: readonly string[];
}

/** The stable serialization of a block's identity: its top-level Yjs item id. */
export function frontierBlockId(id: { clientID: number; clock: number }): string {
  return `${id.clientID}:${id.clock}`;
}

/**
 * The frontier a result rendered from `doc` records:
 * `(prev.unshown ∪ changedSince(prev, doc)) ∩ blocks(doc) − shownInFull`.
 * A block changed when some item in its subtree (children, text, formats,
 * attribute entries including overwritten ones) is visible at exactly one of
 * the two cuts, so text typed and deleted in between changes nothing. An
 * absent, undecodable or uncontained `prev` is the empty snapshot: every block
 * not shown in full is unshown.
 */
export function nextObservationFrontier(
  doc: Y.Doc,
  prev: ObservationFrontier | null | undefined,
  shownInFull: ReadonlySet<string>,
): ObservationFrontier {
  const current = Y.snapshot(doc);
  const blocks = getTopLevelXmlBlocks(doc).map((block) => frontierBlockId(getBlockItemId(block)));
  const previous = prev ? decodeSnapshot(prev.snapshot) : null;
  let unshown: (id: string) => boolean;
  if (!prev || !previous || !containsSnapshot(current, previous)) {
    unshown = () => true;
  } else {
    const carried = new Set(prev.unshown);
    const changed = Y.equalSnapshots(previous, current)
      ? new Set<string>()
      : changedBlocks(doc, previous, current);
    unshown = (id) => carried.has(id) || changed.has(id);
  }
  return {
    snapshot: Y.encodeSnapshotV2(current),
    unshown: blocks.filter((id) => unshown(id) && !shownInFull.has(id)),
  };
}

function decodeSnapshot(bytes: Uint8Array): Y.Snapshot | null {
  try {
    return Y.decodeSnapshotV2(bytes);
  } catch {
    return null;
  }
}

type Range = readonly [start: number, end: number];

/**
 * True when `current` holds every struct and every deletion `previous` names:
 * each state-vector clock is reached and each deleted range is deleted. A state
 * vector alone accepts a snapshot whose staged deletion was refused, since a
 * delete-only update allocates no clock.
 */
function containsSnapshot(current: Y.Snapshot, previous: Y.Snapshot): boolean {
  for (const [client, clock] of previous.sv) {
    if (clock > 0 && (current.sv.get(client) ?? 0) < clock) return false;
  }
  for (const [client, ranges] of previous.ds.clients) {
    if (!covered(deleteRanges(ranges), deleteRanges(current.ds.clients.get(client) ?? [])))
      return false;
  }
  return true;
}

/**
 * Blocks with an item visible at exactly one cut. Given containment, those
 * items are exactly the clocks born before `previous` and deleted since, plus
 * the clocks born since and still visible; only their structs are visited,
 * never the rest of the history.
 */
function changedBlocks(doc: Y.Doc, previous: Y.Snapshot, current: Y.Snapshot): Set<string> {
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const changed = new Set<string>();
  for (const [client, clock] of current.sv) {
    const before = previous.sv.get(client) ?? 0;
    const deletedNow = deleteRanges(current.ds.clients.get(client) ?? []);
    const deletedBefore = deleteRanges(previous.ds.clients.get(client) ?? []);
    const flipped = [
      ...below(subtract(deletedNow, deletedBefore), before),
      ...subtract([[before, clock]], deletedNow),
    ];
    if (flipped.length === 0) continue;
    const structs = doc.store.clients.get(client) ?? [];
    for (const [start, end] of flipped) {
      for (let index = Y.findIndexSS(structs, start); index < structs.length; index += 1) {
        const struct = structs[index];
        if (struct.id.clock >= end) break;
        if (!(struct instanceof Y.Item)) continue;
        const block = topLevelItem(struct, fragment);
        if (block)
          changed.add(frontierBlockId({ clientID: block.id.client, clock: block.id.clock }));
      }
    }
  }
  return changed;
}

/** The fragment child whose subtree holds `item`, or null outside the document fragment. */
function topLevelItem(item: Y.Item, fragment: Y.XmlFragment): Y.Item | null {
  let current = item;
  for (;;) {
    const parent = current.parent;
    if (!(parent instanceof Y.AbstractType)) return null;
    if (parent._item === null) return parent === fragment ? current : null;
    current = parent._item;
  }
}

function deleteRanges(items: readonly { clock: number; len: number }[]): Range[] {
  const sorted = items
    .map((item): Range => [item.clock, item.clock + item.len])
    .sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Every range of `inner` lies within `outer`; both sorted and merged. */
function covered(inner: readonly Range[], outer: readonly Range[]): boolean {
  let index = 0;
  for (const [start, end] of inner) {
    while (index < outer.length && outer[index][1] <= start) index += 1;
    const range = outer[index];
    if (!range || range[0] > start || range[1] < end) return false;
  }
  return true;
}

/** `ranges` minus `removed`, both sorted and merged; one pass over each. */
function subtract(ranges: readonly Range[], removed: readonly Range[]): Range[] {
  const result: Range[] = [];
  let first = 0;
  for (const [start, end] of ranges) {
    while (first < removed.length && removed[first][1] <= start) first += 1;
    let cursor = start;
    for (let index = first; index < removed.length && removed[index][0] < end; index += 1) {
      const [from, to] = removed[index];
      if (from > cursor) result.push([cursor, from]);
      cursor = Math.max(cursor, to);
      if (cursor >= end) break;
    }
    if (cursor < end) result.push([cursor, end]);
  }
  return result;
}

/** The parts of `ranges` below `limit`. */
function below(ranges: readonly Range[], limit: number): Range[] {
  return ranges.flatMap(([start, end]): Range[] =>
    start < limit ? [[start, Math.min(end, limit)]] : [],
  );
}
