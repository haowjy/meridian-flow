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

/**
 * Plain text of the visible top-level blocks that still hold these items (inserted or
 * tombstoned), one line per block in document order; `null` when none survives. A block that
 * was itself removed or rebuilt contributes nothing: no surviving identity says which current
 * block replaced it.
 */
export function blockTextAt(
  fragment: Y.XmlFragment,
  ranges: readonly { client: number; clock: number; len: number }[],
): string | null {
  const doc = fragment.doc;
  if (!doc) return null;
  const blocks = new Set<Y.Item>();
  for (const range of ranges)
    for (let clock = range.clock; clock < range.clock + range.len; ) {
      const item = findItem(doc, Y.createID(range.client, clock));
      if (!item) break;
      clock = item.id.clock + item.length;
      let top: Y.Item | null = item;
      while (top && top.parent !== fragment)
        top = top.parent instanceof Y.AbstractType ? top.parent._item : null;
      if (top && !top.deleted) blocks.add(top);
    }
  // Nested blocks (list items, cells) take a line each; inline runs within a block join.
  const text = (type: unknown): string => {
    if (type instanceof Y.XmlText)
      return type
        .toDelta()
        .map((op: { insert: unknown }) => (typeof op.insert === "string" ? op.insert : ""))
        .join("");
    if (!(type instanceof Y.XmlElement)) return "";
    const children = type.toArray();
    const inline = children.some((child) => child instanceof Y.XmlText);
    return children
      .map(text)
      .filter((part) => inline || part)
      .join(inline ? "" : "\n");
  };
  const lines: string[] = [];
  for (let item = fragment._start; item; item = item.right)
    if (blocks.has(item)) lines.push(text(item.content.getContent()[0]));
  return lines.length ? lines.join("\n") : null;
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
