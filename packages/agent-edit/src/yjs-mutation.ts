/**
 * Pinned Yjs 13.6.31 mutation adapter. Owns retained-struct lookup, root/nested
 * parent resolution, fresh-item integration and tombstone splitting/transfer.
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

/** Visible text-run edges, by item identity, for a host's nearest-survivor fallback. */
export function textItemBoundaryPositions(text: Y.XmlText): Y.RelativePosition[] {
  const positions: Y.RelativePosition[] = [];
  for (let item = text._start; item; item = item.right) {
    if (item.deleted || !item.countable) continue;
    positions.push(
      new Y.RelativePosition(text._item?.id ?? null, null, item.id, 0),
      new Y.RelativePosition(
        text._item?.id ?? null,
        null,
        Y.createID(item.id.client, item.id.clock + item.length - 1),
        -1,
      ),
    );
  }
  return positions;
}

/** Root identity without exposing the private parent item to hosts. */
export function rootTypeKey(item: Y.Item): string | null {
  const parent = item.parent;
  return parent instanceof Y.AbstractType && parent._item === null
    ? Y.findRootTypeKey(parent)
    : null;
}

/** Copy only an operation's own content; never import a source container's children. */
export function integrateFreshCopy(
  transaction: Y.Transaction,
  source: Y.Doc,
  item: Y.Item,
  resolve: (id: Y.ID | null) => Y.ID | null,
): Y.ID | null {
  const document = transaction.doc;
  const original = findItem(source, item.id);
  const parent = original?.parent;
  if (!original || !(parent instanceof Y.AbstractType)) return null;
  const parentId = resolve(parent._item?.id ?? null);
  const parentItem = parentId ? findItem(document, parentId) : null;
  const destination =
    parent._item === null
      ? document.get(Y.findRootTypeKey(parent))
      : parentItem && !parentItem.deleted && parentItem.content instanceof Y.ContentType
        ? parentItem.content.type
        : null;
  const origin = resolve(item.origin);
  const rightOrigin = resolve(item.rightOrigin);
  if (!destination || (item.origin && !origin) || (item.rightOrigin && !rightOrigin)) return null;
  const left = origin ? Y.getItemCleanEnd(transaction, document.store, origin) : null;
  const right = rightOrigin ? Y.getItemCleanStart(transaction, rightOrigin) : null;
  if ((left && left.parent !== destination) || (right && right.parent !== destination)) return null;
  const id = Y.createID(document.clientID, Y.getState(document.store, document.clientID));
  new Y.Item(
    id,
    left,
    origin,
    right,
    rightOrigin,
    destination,
    original.parentSub,
    item.content.copy(),
  ).integrate(transaction, 0);
  // Source delete sets name old clocks. Transfer current tombstones onto fresh
  // clocks, including partially deleted strings and deleted dependency slots.
  for (const old of source.store.clients.get(item.id.client) ?? []) {
    if (!(old instanceof Y.Item) || !old.deleted) continue;
    const start = Math.max(item.id.clock, old.id.clock);
    const end = Math.min(item.id.clock + item.length, old.id.clock + old.length);
    if (start >= end) continue;
    Y.getItemCleanEnd(
      transaction,
      document.store,
      Y.createID(id.client, id.clock + end - item.id.clock - 1),
    );
    Y.getItemCleanStart(
      transaction,
      Y.createID(id.client, id.clock + start - item.id.clock),
    ).delete(transaction);
  }
  return id;
}

/** Unknown or partly live source ranges count as loss; tombstones alone do not. */
export function hasLiveContent(source: Y.Doc, item: Y.Item): boolean {
  const parts = (source.store.clients.get(item.id.client) ?? []).filter(
    (part) =>
      part.id.clock < item.id.clock + item.length && item.id.clock < part.id.clock + part.length,
  );
  return parts.length === 0 || parts.some((part) => !(part instanceof Y.Item) || !part.deleted);
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
    ignoreRemoteMapChanges: true,
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

/** String clocks only; container and formatting structs have no textual excerpt. */
export function textInRanges(
  doc: Y.Doc,
  ranges: readonly { client: number; clock: number; len: number }[],
): string {
  return ranges
    .flatMap((range) =>
      Array.from({ length: range.len }, (_, offset) => {
        const clock = range.clock + offset;
        const item = findItem(doc, Y.createID(range.client, clock));
        return item?.content instanceof Y.ContentString
          ? item.content.str[clock - item.id.clock]
          : "";
      }),
    )
    .join("");
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
