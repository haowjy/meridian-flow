import * as Y from "yjs";

type StackItem = Y.UndoManager["undoStack"][number];

/** On a stack item: the document's state vector right after its change was done (or redone). */
const AFTER_META = "meridian-step-after";

/** Records the document's state now as the point `touchedSince` measures `stackItem` from. */
export function markStepDone(doc: Y.Doc, stackItem: StackItem): void {
  stackItem.meta.set(AFTER_META, Y.decodeStateVector(Y.encodeStateVector(doc)));
}

/**
 * Whether an edit since the step was marked done deleted text it inserted, wrote beside text it
 * inserted or deleted, or deleted a block holding either.
 */
export function touchedSince(doc: Y.Doc, stackItem: StackItem): boolean {
  const after = stackItem.meta.get(AFTER_META) as Map<number, number>;
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
    // The same client typing right after it merges into this struct, so its start stays older.
    if (inserted && struct.id.clock + struct.length > (after.get(struct.id.client) ?? 0))
      return true;
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
