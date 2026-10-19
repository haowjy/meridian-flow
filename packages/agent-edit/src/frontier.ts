/**
 * Observation frontiers: what document state a model was shown. A frontier is
 * a Yjs snapshot of the document a result was rendered from plus the blocks
 * that changed since the model's previous frontier and that this result did not
 * show in full ("unshown"). Pure Yjs; the host names rooms and stores frontiers.
 */
import * as Y from "yjs";
import { type BlockItemId, getBlockItemId, getTopLevelXmlBlocks } from "./model/block-hash.js";
import { PROSEMIRROR_FRAGMENT_NAME } from "./model/prosemirror-fragment.js";

export interface ObservationFrontier {
  /** The host's opaque label for the room the document belongs to; carried, never read. */
  room: string;
  /** `Y.encodeSnapshotV2` of the document the result was rendered from. */
  snapshot: Uint8Array;
  /** Block ids (`client:clock` of the top-level item), in document order. */
  unshown: readonly string[];
}

/**
 * A host's lookup of the model's latest frontier for a room. Never throws: an
 * unavailable frontier is `null`, the empty one.
 */
export type FrontierLookup = (room: string) => Promise<ObservationFrontier | null>;

/**
 * A call's lookups. `recording` chains what a result records (a sibling call's
 * result counts as seen); `planning` is the model's view as of the request that
 * produced the call (C4), which a write plans on; `reply` is what the reply has
 * itself done since that request, which the view replays after the frontier.
 */
export interface FrontierLookups {
  recording: FrontierLookup;
  /** Required for a model reply's write; a read plans nothing. */
  planning?: FrontierLookup;
  reply?: ReplyMutations;
}

/**
 * One provider reply's own accepted mutations per document, in execution order: its writes
 * once their save's root commit settled them, its immediate writes and its undo, redo and
 * revert, each as the exact bytes it committed. The reply owns it from its first tool call to
 * its terminal boundary, which clears it; nothing caps or evicts it before then.
 */
export interface ReplyMutations {
  updates(docId: string): readonly Uint8Array[];
  append(docId: string, updates: readonly Uint8Array[]): void;
  clear(): void;
}

export function createReplyMutations(): ReplyMutations {
  const docs = new Map<string, Uint8Array[]>();
  return {
    updates: (docId) => docs.get(docId) ?? [],
    append(docId, updates) {
      if (updates.length) docs.set(docId, [...(docs.get(docId) ?? []), ...updates]);
    },
    clear: () => docs.clear(),
  };
}

/** The stable serialization of a block's identity: its top-level Yjs item id. */
export function frontierBlockId(id: { clientID: number; clock: number }): string {
  return `${id.clientID}:${id.clock}`;
}

/**
 * What `doc` holds that the model's previous frontier there doesn't: the one computation
 * behind a result's listing and the unshown it records. A block changed when some item in its
 * subtree (children, text, formats, attribute entries including overwritten ones) is visible at
 * exactly one of the two cuts, so text typed and deleted in between changes nothing. An absent,
 * undecodable or uncontained `prev` is the empty snapshot: every block is unseen, and nothing
 * is listed as changed, since the model saw no earlier version to compare with.
 */
export interface FrontierDelta {
  snapshot: Y.Snapshot;
  /** Every present top-level block id, in document order. */
  blocks: readonly string[];
  /** Present blocks not seen in their current form: `prev.unshown ∪ changed`, or all of them. */
  unseen: ReadonlySet<string>;
  /** Present blocks changed since a usable `prev`, in document order: what a result lists. */
  changed: readonly string[];
  /** Blocks visible at a usable `prev` and gone now. */
  removed: readonly BlockItemId[];
}

export function frontierDelta(doc: Y.Doc, prev: ObservationFrontier | null): FrontierDelta {
  const snapshot = Y.snapshot(doc);
  const blocks = getTopLevelXmlBlocks(doc).map((block) => frontierBlockId(getBlockItemId(block)));
  const previous = prev ? decodeSnapshot(prev.snapshot) : null;
  if (!prev || !previous || !containsSnapshot(snapshot, previous))
    return { snapshot, blocks, unseen: new Set(blocks), changed: [], removed: [] };
  const flipped = Y.equalSnapshots(previous, snapshot)
    ? new Map<string, Y.Item>()
    : changedBlocks(doc, previous, snapshot);
  const present = new Set(blocks);
  const changed = blocks.filter((id) => flipped.has(id));
  return {
    snapshot,
    blocks,
    unseen: new Set([...prev.unshown.filter((id) => present.has(id)), ...changed]),
    changed,
    removed: [...flipped]
      .filter(([id]) => !present.has(id))
      .map(([, item]) => ({ clientID: item.id.client, clock: item.id.clock })),
  };
}

/** The frontier a result records: `unseen − shownInFull`, at the delta's cut. */
export function recordedFrontier(
  room: string,
  delta: FrontierDelta,
  shownInFull: ReadonlySet<string>,
): ObservationFrontier {
  return {
    room,
    snapshot: Y.encodeSnapshotV2(delta.snapshot),
    unshown: delta.blocks.filter((id) => delta.unseen.has(id) && !shownInFull.has(id)),
  };
}

export function decodeSnapshot(bytes: Uint8Array): Y.Snapshot | null {
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
export function containsSnapshot(current: Y.Snapshot, previous: Y.Snapshot): boolean {
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
 * Blocks with an item visible at exactly one cut, by id, each with its top-level item. Given
 * containment, those items are exactly the clocks born before `previous` and deleted since,
 * plus the clocks born since and still visible; only their structs are visited, never the rest
 * of the history.
 */
function changedBlocks(doc: Y.Doc, previous: Y.Snapshot, current: Y.Snapshot): Map<string, Y.Item> {
  const changed = new Map<string, Y.Item>();
  walkChangedRanges(doc, previous, current, (block) => {
    changed.set(frontierBlockId({ clientID: block.id.client, clock: block.id.clock }), block);
  });
  return changed;
}

/** Words whose visibility flipped, clipped to the changed part of each retained item. */
export function changedWords(
  doc: Y.Doc,
  previous: Y.Snapshot,
  current: Y.Snapshot,
  region: ReadonlySet<string>,
): number {
  let words = 0;
  walkChangedRanges(doc, previous, current, (block, item, start, end) => {
    if (!region.has(frontierBlockId({ clientID: block.id.client, clock: block.id.clock }))) return;
    // Formats and container items have no prose; inline atoms still count as a fragment.
    if (item.content instanceof Y.ContentString) {
      const text = item.content.str.slice(start - item.id.clock, end - item.id.clock);
      if (text.length) words += Math.max(1, text.trim().split(/\s+/u).filter(Boolean).length);
    } else if (item.content instanceof Y.ContentEmbed) words += 1;
  });
  return words;
}

/** One flipped-range walk serves both credit and the region check. */
function walkChangedRanges(
  doc: Y.Doc,
  previous: Y.Snapshot,
  current: Y.Snapshot,
  visit: (block: Y.Item, item: Y.Item, start: number, end: number) => void,
): void {
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
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
          visit(
            block,
            struct,
            Math.max(start, struct.id.clock),
            Math.min(end, struct.id.clock + struct.length),
          );
      }
    }
  }
}

/**
 * Top-level blocks every visible item of which (the block, its attribute entries, children,
 * text and formats) one of `updates` created: text a write sent in its own call, which the
 * model therefore has verbatim. Only blocks those updates touch are walked.
 */
export function writtenOnlyBy(doc: Y.Doc, updates: readonly Uint8Array[]): Set<string> {
  const ranges = new Map<number, [number, number][]>();
  for (const update of updates)
    for (const struct of Y.decodeUpdate(update).structs) {
      if (!(struct instanceof Y.Item)) continue;
      const own = ranges.get(struct.id.client) ?? [];
      own.push([struct.id.clock, struct.id.clock + struct.length]);
      ranges.set(struct.id.client, own);
    }
  const merged = new Map(
    [...ranges].map(([client, own]) => [
      client,
      deleteRanges(own.map(([clock, end]) => ({ clock, len: end - clock }))),
    ]),
  );
  const isOwn = (item: Y.Item) =>
    covered([[item.id.clock, item.id.clock + item.length]], merged.get(item.id.client) ?? []);
  const onlyOwn = (item: Y.Item): boolean => {
    if (!isOwn(item)) return false;
    if (!(item.content instanceof Y.ContentType)) return true;
    const type = item.content.type;
    for (let child = type._start; child; child = child.right)
      if (!child.deleted && !onlyOwn(child)) return false;
    for (const entry of type._map.values()) if (!entry.deleted && !onlyOwn(entry)) return false;
    return true;
  };
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const touched = new Map<string, Y.Item>();
  for (const [client, own] of merged) {
    const structs = doc.store.clients.get(client) ?? [];
    for (const [start, end] of own)
      for (let index = Y.findIndexSS(structs, start); index < structs.length; index += 1) {
        const struct = structs[index];
        if (struct.id.clock >= end) break;
        const block = struct instanceof Y.Item ? topLevelItem(struct, fragment) : null;
        if (block && !block.deleted)
          touched.set(frontierBlockId({ clientID: block.id.client, clock: block.id.clock }), block);
      }
  }
  return new Set([...touched].filter(([, block]) => onlyOwn(block)).map(([id]) => id));
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

/** A planning frontier is usable only in its room and when all its history survives. */
export function planningSnapshot(
  doc: Y.Doc,
  room: string,
  frontier: ObservationFrontier | null,
): Y.Snapshot | null {
  if (!frontier || frontier.room !== room) return null;
  const snapshot = decodeSnapshot(frontier.snapshot);
  return snapshot && containsSnapshot(Y.snapshot(doc), snapshot) ? snapshot : null;
}

/**
 * A disposable offline peer of the request's cut plus kept staged and settled reply updates.
 * A save is not permanent membership: Discard can retire its structs or deletions later.
 */
export function createPlanningView(
  room: Y.Doc,
  snapshot: Y.Snapshot,
  ownUpdates: readonly Uint8Array[],
): Y.Doc | null {
  const view = new Y.Doc({ gc: false });
  try {
    const roomCut = Y.snapshot(room);
    Y.createDocFromSnapshot(room, snapshot, view);
    for (const update of ownUpdates) {
      if (Y.snapshotContainsUpdate(roomCut, update)) Y.applyUpdate(view, update);
    }
    if (
      !view.store.pendingStructs &&
      !view.store.pendingDs &&
      containsSnapshot(roomCut, Y.snapshot(view))
    )
      return view;
  } catch {
    // An unavailable retained cut is not a usable planning view.
  }
  view.destroy();
  return null;
}
