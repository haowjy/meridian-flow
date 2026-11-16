import * as Y from "yjs";

type StackItem = Y.UndoManager["undoStack"][number];

/**
 * Whether an edit since the step (`after`: the state vector right after it) deleted text it
 * inserted, wrote beside text it inserted or deleted, or deleted a block holding either.
 */
export function touchedSince(
  doc: Y.Doc,
  stackItem: StackItem,
  after: Map<number, number>,
): boolean {
  const { insertions, deletions } = stackItem;
  const ours = (id: Y.ID | null) =>
    id !== null && (Y.isDeleted(insertions, id) || Y.isDeleted(deletions, id));
  const later = (struct: Y.Item) => struct.id.clock >= (after.get(struct.id.client) ?? 0);
  // Beside: only older deleted text in between. An insert skips past every deleted item at its
  // place, so after an earlier Discard was undone its origin is that Discard's text, not this one's.
  const besideLater = (start: Y.Item | null, side: "left" | "right") => {
    for (let next = start; next && !ours(next.id); next = next[side]) {
      if (later(next)) return true;
      if (!next.deleted) return false;
    }
    return false;
  };
  const touched = (struct: Y.Item | Y.AbstractStruct, inserted: boolean) => {
    // A collected struct went with a deleted block.
    if (!(struct instanceof Y.Item)) return true;
    if (inserted && struct.deleted && !Y.isDeleted(deletions, struct.id)) return true;
    for (let parent = struct.parent; parent instanceof Y.AbstractType && parent._item; ) {
      const holder: Y.Item = parent._item;
      if (holder.deleted && !Y.isDeleted(deletions, holder.id)) return true;
      parent = holder.parent;
    }
    return besideLater(struct.left, "left") || besideLater(struct.right, "right");
  };
  for (const [set, inserted] of [
    [insertions, true],
    [deletions, false],
  ] as const)
    for (const [client, ranges] of set.clients) {
      const structs = doc.store.clients.get(client) ?? [];
      for (const { clock, len } of ranges)
        for (let at = Y.findIndexSS(structs, clock); at < structs.length; at++) {
          const struct = structs[at];
          if (!struct || struct.id.clock >= clock + len) break;
          if (touched(struct, inserted)) return true;
        }
    }
  return false;
}
