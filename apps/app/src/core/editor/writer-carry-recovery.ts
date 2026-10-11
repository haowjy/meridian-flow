/** Re-expresses pending writer operations whose own identities/anchors survive retirement. */
import { RESTORATION_CLAIMS_TYPE } from "@meridian/prosemirror-schema";
import * as Y from "yjs";

function itemAt(document: Y.Doc, id: Y.ID): Y.Item | null {
  const item = document.store.clients
    .get(id.client)
    ?.find((struct) => struct.id.clock <= id.clock && id.clock < struct.id.clock + struct.length);
  return item instanceof Y.Item ? item : null;
}

export function recoverWriterCarry(
  document: Y.Doc,
  sourceState: Uint8Array,
  pendingUpdate: Uint8Array,
): boolean {
  const source = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(source, sourceState);
    const remaining = Y.decodeUpdateV2(pendingUpdate).structs.filter(
      (item): item is Y.Item => item instanceof Y.Item,
    );
    const copies: Array<{ source: Y.ID; target: Y.ID; length: number }> = [];
    const resolve = (id: Y.ID | null): Y.ID | null => {
      if (!id) return null;
      const copy = copies.find(
        (range) =>
          range.source.client === id.client &&
          range.source.clock <= id.clock &&
          id.clock < range.source.clock + range.length,
      );
      return copy
        ? Y.createID(copy.target.client, copy.target.clock + id.clock - copy.source.clock)
        : itemAt(document, id)
          ? id
          : null;
    };
    let lost = false;
    document.transact((transaction) => {
      // A rescued parent or sibling may unlock another pending operation. The
      // source's clock prefix alone never creates an insertion dependency here.
      let progress = true;
      while (remaining.length && progress) {
        progress = false;
        for (let index = 0; index < remaining.length; ) {
          const item = remaining[index];
          if (!item) break;
          const original = itemAt(source, item.id);
          const parent = original?.parent;
          if (!original || !(parent instanceof Y.AbstractType)) {
            index += 1;
            continue;
          }
          if (parent._item === null && Y.findRootTypeKey(parent) === RESTORATION_CLAIMS_TYPE) {
            remaining.splice(index, 1);
            progress = true;
            continue;
          }
          const parentId = resolve(parent._item?.id ?? null);
          const parentItem = parentId ? itemAt(document, parentId) : null;
          const destination =
            parent._item === null
              ? document.get(Y.findRootTypeKey(parent))
              : parentItem && !parentItem.deleted && parentItem.content instanceof Y.ContentType
                ? parentItem.content.type
                : null;
          const origin = resolve(item.origin);
          const rightOrigin = resolve(item.rightOrigin);
          if (!destination || (item.origin && !origin) || (item.rightOrigin && !rightOrigin)) {
            index += 1;
            continue;
          }
          const left = origin ? Y.getItemCleanEnd(transaction, document.store, origin) : null;
          const right = rightOrigin ? Y.getItemCleanStart(transaction, rightOrigin) : null;
          if ((left && left.parent !== destination) || (right && right.parent !== destination)) {
            index += 1;
            continue;
          }
          const id = Y.createID(document.clientID, Y.getState(document.store, document.clientID));
          // Copy only the pending operation's own content. The retired source
          // snapshot is context, never a replayable successor update.
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
          copies.push({ source: item.id, target: id, length: item.length });
          // Pending delete sets name old clocks. Transfer the source's current
          // tombstones onto these fresh clocks, including partially deleted text.
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
          remaining.splice(index, 1);
          progress = true;
        }
      }
      lost = remaining.some((item) => {
        const parts = (source.store.clients.get(item.id.client) ?? []).filter(
          (part) =>
            part.id.clock < item.id.clock + item.length &&
            item.id.clock < part.id.clock + part.length,
        );
        return (
          parts.length === 0 || parts.some((part) => !(part instanceof Y.Item) || !part.deleted)
        );
      });
    });
    return lost;
  } finally {
    source.destroy();
  }
}
