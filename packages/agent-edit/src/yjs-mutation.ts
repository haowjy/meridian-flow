/**
 * Pinned Yjs 13.6.31 mutation adapter. Owns retained-struct lookup, root/nested
 * parent resolution, fresh-item integration and tombstone splitting/transfer.
 * Browser-safe: no undo engine, host lifecycle or attribution policy. Recovery
 * and forward-inverse hosts supply identity mapping and choose which items to copy.
 * Keep the exact yjs manifest pin synchronized with these private invariants.
 */
import * as Y from "yjs";

export function findItem(document: Y.Doc, id: Y.ID): Y.Item | null {
  const item = document.store.clients
    .get(id.client)
    ?.find((struct) => struct.id.clock <= id.clock && id.clock < struct.id.clock + struct.length);
  return item instanceof Y.Item ? item : null;
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
