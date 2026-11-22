/**
 * Pinned Yjs 13.6.33 mutation adapter. Owns retained-struct lookup, root/nested
 * parent resolution and tombstone splitting.
 * Keep the exact yjs manifest pin synchronized with these private invariants.
 */
import * as Y from "yjs";

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

export function itemIsInFragment(doc: Y.Doc, item: Y.Item, root: string): boolean {
  // Typing the root first: on a doc that only integrated updates, `getXmlFragment` replaces
  // the untyped root with a new instance, so a root reached before it would never match.
  const fragment = doc.getXmlFragment(root);
  let parent = item.parent;
  while (parent instanceof Y.AbstractType && parent._item) parent = parent._item.parent;
  return parent === fragment;
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
