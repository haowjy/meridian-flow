/**
 * Pinned Yjs 13.6.33 mutation adapter. Owns retained-struct lookup, root/nested
 * parent resolution and tombstone splitting.
 * Browser-safe: no undo policy, host lifecycle or attribution policy. Recovery
 * and forward-inverse hosts supply identity mapping and choose mutation targets.
 * Keep the exact yjs manifest pin synchronized with these private invariants.
 */
import * as Y from "yjs";

export function findItem(document: Y.Doc, id: Y.ID): Y.Item | null {
  const structs = document.store.clients.get(id.client);
  const last = structs?.at(-1);
  if (
    !structs ||
    !last ||
    id.clock < structs[0].id.clock ||
    id.clock >= last.id.clock + last.length
  )
    return null;
  const item = structs[Y.findIndexSS(structs, id.clock)];
  return item instanceof Y.Item ? item : null;
}

/** Retained item spans intersecting a clock range; GC and unknown clocks are omitted. */
export function* itemsInRange(
  document: Y.Doc,
  range: { client: number; clock: number; len: number },
): Generator<{ item: Y.Item; clock: number; len: number }> {
  const structs = document.store.clients.get(range.client);
  const last = structs?.at(-1);
  if (!structs || !last) return;
  const end = Math.min(range.clock + range.len, last.id.clock + last.length);
  const clock = Math.max(range.clock, structs[0].id.clock);
  if (clock >= end) return;
  for (let i = Y.findIndexSS(structs, clock); i < structs.length; i++) {
    const item = structs[i];
    if (item.id.clock >= end) break;
    const from = Math.max(clock, item.id.clock);
    const to = Math.min(end, item.id.clock + item.length);
    if (item instanceof Y.Item && from < to) yield { item, clock: from, len: to - from };
  }
}

export function allItems(doc: Y.Doc): Y.Item[] {
  return [...doc.store.clients.values()].flat().filter((s): s is Y.Item => s instanceof Y.Item);
}
export function itemIsInFragment(doc: Y.Doc, item: Y.Item, root: string): boolean {
  // Typing the root first: on a doc that only integrated updates, `getXmlFragment` replaces
  // the untyped root with a new instance, so a root reached before it would never match.
  const fragment = doc.getXmlFragment(root);
  let parent = item.parent;
  while (parent instanceof Y.AbstractType && parent._item) parent = parent._item.parent;
  return parent === fragment;
}

export function ancestorItems(item: Y.Item): Y.Item[] {
  const ancestors: Y.Item[] = [];
  let parent = item.parent;
  while (parent instanceof Y.AbstractType && parent._item) {
    ancestors.push(parent._item);
    parent = parent._item.parent;
  }
  return ancestors;
}

export function itemIsVisible(doc: Y.Doc, id: Y.ID): boolean {
  const item = findItem(doc, id);
  return !!item && !item.deleted && ancestorItems(item).every((ancestor) => !ancestor.deleted);
}

/** Hydrate cold lineage without persisting private redone pointers. */
export function hydrateRedone(doc: Y.Doc, pairs: readonly { source: Y.ID; target: Y.ID }[]): void {
  doc.transact((transaction) => {
    for (let n = 0; n < pairs.length; ) {
      const { source, target } = pairs[n];
      let length = 1;
      while (n + length < pairs.length) {
        const next = pairs[n + length];
        if (
          next.source.client !== source.client ||
          next.target.client !== target.client ||
          next.source.clock !== source.clock + length ||
          next.target.clock !== target.clock + length
        )
          break;
        length++;
      }
      // A contiguous alias uses Yjs's own item offsets; do not split every character.
      for (let offset = 0; offset < length; ) {
        const start = Y.createID(source.client, source.clock + offset);
        const item = Y.getItemCleanStart(transaction, start);
        const count = Math.min(item.length, length - offset);
        Y.getItemCleanEnd(
          transaction,
          doc.store,
          Y.createID(source.client, start.clock + count - 1),
        );
        item.redone = Y.createID(target.client, target.clock + offset);
        offset += count;
      }
      n += length;
    }
  });
}

export function snapshotRedone(doc: Y.Doc): Map<string, string | undefined> {
  return new Map(
    allItems(doc).map((item) => [
      identityKey(item.id),
      item.redone ? identityKey(item.redone) : undefined,
    ]),
  );
}

export function changedRedone(
  doc: Y.Doc,
  before: Map<string, string | undefined>,
): { source: Y.ID; target: Y.ID }[] {
  return allItems(doc).flatMap((item) => {
    const target = item.redone;
    if (!target || before.get(identityKey(item.id)) === identityKey(target)) return [];
    return Array.from({ length: item.length }, (_, n) => ({
      source: Y.createID(item.id.client, item.id.clock + n),
      target: Y.createID(target.client, target.clock + n),
    }));
  });
}

const identityKey = (id: Y.ID): string => `${id.client}:${id.clock}`;

/** Execute an already-admitted selection with Yjs's own parent/sibling tracing. */
export function executeUndo(
  doc: Y.Doc,
  root: string,
  client: number,
  stack: {
    insertions: ReturnType<typeof Y.createDeleteSet>;
    deletions: ReturnType<typeof Y.createDeleteSet>;
    meta: Map<unknown, unknown>;
  },
  deleteFilter: (item: Y.Item) => boolean,
): Uint8Array[] {
  const updates: Uint8Array[] = [];
  const collect = (update: Uint8Array) => updates.push(update);
  const manager = new Y.UndoManager(doc.getXmlFragment(root), {
    trackedOrigins: new Set(),
    ignoreRemoteMapChanges: false,
    deleteFilter,
  });
  doc.clientID = client;
  manager.undoStack.push(stack);
  doc.on("update", collect);
  try {
    manager.undo();
  } finally {
    doc.off("update", collect);
    manager.destroy();
  }
  return updates;
}

/** Item clock ranges by client: a delete set, or the items an update inserts. */
export type ItemRanges = { clients: Map<number, ReadonlyArray<{ clock: number; len: number }>> };

function slicesIn(item: Y.Item, ranges: ItemRanges): Array<{ from: number; to: number }> {
  const clientRanges = ranges.clients.get(item.id.client);
  if (!clientRanges) return [];
  const itemStart = item.id.clock;
  const itemEnd = itemStart + item.length;
  const slices: Array<{ from: number; to: number }> = [];
  for (const range of clientRanges) {
    const from = Math.max(itemStart, range.clock);
    const to = Math.min(itemEnd, range.clock + range.len);
    if (from < to) slices.push({ from: from - itemStart, to: to - itemStart });
  }
  return slices;
}

/**
 * The text of the items in `ranges`, in document order, one line per block; with `liveOnly`,
 * only items nothing has deleted. Text outside the ranges between two kept runs in one block is
 * joined by `gap`, so changes in two places never read as one word. It reads document positions,
 * never clocks, which run opposite to position for a right-to-left write.
 *
 * Traversal follows Y item identity and logical XML order. It never compares
 * sibling positions between before and after documents, which would be
 * ambiguous when repeated or nested siblings have the same shape.
 */
export function textInRanges(
  fragment: Y.XmlFragment,
  ranges: ItemRanges,
  { liveOnly = false, gap = "\n" }: { liveOnly?: boolean; gap?: string } = {},
) {
  const nodeTypes: string[] = [];
  let resolvedClockCount = 0;
  let contentUnavailable = false;
  let text = "";
  let pending: "" | "gap" | "block" = "";
  const breakAfter = (kind: "gap" | "block") => {
    if (text && pending !== "block") pending = kind;
  };
  const walk = (start: Y.Item | null) => {
    // An element among text runs is an inline atom: a gap in its line, not a block end.
    let textblock = false;
    for (let item = start; item && !textblock; item = item.right)
      textblock = item.content instanceof Y.ContentType && item.content.type instanceof Y.XmlText;
    const breakKind = textblock ? "gap" : "block";
    for (let item = start; item; item = item.right) {
      const slices = slicesIn(item, ranges);
      const content = item.content;
      resolvedClockCount += slices.reduce((total, slice) => total + slice.to - slice.from, 0);
      if (content instanceof Y.ContentString && !(liveOnly && item.deleted)) {
        const kept = slices.map((slice) => content.str.slice(slice.from, slice.to)).join("");
        if (kept.length < content.str.length) breakAfter("gap");
        if (kept) {
          if (pending) text += pending === "block" ? "\n" : gap;
          text += kept;
          pending = "";
        }
      } else if (slices.length > 0 && content instanceof Y.ContentDeleted) {
        contentUnavailable = true;
      }
      if (!(content instanceof Y.ContentType)) continue;
      const child = content.type;
      const nodeName = child instanceof Y.XmlElement ? child.nodeName : undefined;
      if (slices.length > 0 && nodeName && !nodeTypes.includes(nodeName)) nodeTypes.push(nodeName);
      if (nodeName) breakAfter(breakKind);
      walk(child._start);
      if (nodeName) breakAfter(breakKind);
    }
  };
  walk(fragment._start);
  return { text, nodeTypes, resolvedClockCount, contentUnavailable };
}

/** Transaction deltas only; state-vector encoding would repeat old tombstones. */
export function captureMutationUpdates(doc: Y.Doc, mutate: () => void): Uint8Array[] {
  const updates: Uint8Array[] = [];
  const collect = (update: Uint8Array) => updates.push(update);
  doc.on("update", collect);
  try {
    mutate();
  } finally {
    doc.off("update", collect);
  }
  return updates;
}

/** Index one decoded update without changing first-match lookup on noncanonical frames. */
export function indexDecodedStructs<T extends { id: Y.ID; length: number }>(
  structs: readonly T[],
): (id: Y.ID) => T | undefined {
  const clients = new Map<number, { values: T[]; ordered: boolean }>();
  for (const struct of structs) {
    const entry = clients.get(struct.id.client) ?? { values: [], ordered: true };
    const last = entry.values.at(-1);
    if (last && last.id.clock + last.length > struct.id.clock) entry.ordered = false;
    entry.values.push(struct);
    clients.set(struct.id.client, entry);
  }
  return (id) => {
    const entry = clients.get(id.client);
    if (!entry) return undefined;
    // decodeUpdate also accepts repeated client blocks out of clock order. Keep their
    // original first-match semantics, including overlaps, rather than changing admission.
    if (!entry.ordered) {
      return entry.values.find(
        (item) => item.id.clock <= id.clock && id.clock < item.id.clock + item.length,
      );
    }
    let lo = 0;
    let hi = entry.values.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const item = entry.values[mid];
      if (id.clock < item.id.clock) hi = mid;
      else if (id.clock >= item.id.clock + item.length) lo = mid + 1;
      else return item;
    }
    return undefined;
  };
}

/** Split existing text boundaries in clock order, before a bulk edit shifts the same struct tail repeatedly. */
export function splitTextBoundaries(
  transaction: Y.Transaction,
  runs: readonly { text: Y.XmlText; offsets: readonly number[] }[],
): void {
  const ids: Y.ID[] = [];
  for (const { text, offsets } of runs) {
    let position = 0;
    let cut = 0;
    for (let item = text._start; item; item = item.right) {
      if (item.deleted || !item.countable) continue;
      const end = position + item.length;
      while (cut < offsets.length && offsets[cut] < end) {
        const offset = offsets[cut++];
        if (offset > position && item.content instanceof Y.ContentString)
          ids.push(Y.createID(item.id.client, item.id.clock + offset - position));
      }
      position = end;
    }
  }
  ids.sort((a, b) => a.client - b.client || a.clock - b.clock);
  for (const id of ids) Y.getItemCleanStart(transaction, id);
}
