// Undo delete filtering that preserves user-owned descendants inside agent-created containers.
import * as Y from "yjs";

interface ItemIdLike {
  client: number;
  clock: number;
}

interface DeleteRangeLike {
  clock: number;
  len: number;
}

interface DeleteSetLike {
  clients: Map<number, DeleteRangeLike[]>;
}

interface StackItemLike {
  insertions: DeleteSetLike;
}

interface ItemLike {
  id: ItemIdLike;
  length: number;
  deleted?: boolean;
  parent?: unknown;
  content?: { type?: unknown };
}

interface TypeLike {
  doc?: { store?: { clients?: Map<number, unknown[]> } };
  _item?: { parent?: unknown } | null;
}

/**
 * Yjs would otherwise delete an agent-created XmlElement even when a human later
 * typed inside it. Skip deleting container type-items that now own live content
 * outside the stack item being undone; the agent-owned text inside still deletes.
 */
export type UndoStackItemLike = StackItemLike & { meta: Map<unknown, unknown> };

export function shouldDeleteUndoItem(item: unknown, stackItem: UndoStackItemLike | null): boolean {
  const contentType = itemLike(item).content?.type;
  if (!isUndoContainer(contentType) || stackItem === null) return true;
  return !hasLiveDescendantOutsideInsertions(contentType, stackItem);
}

function hasLiveDescendantOutsideInsertions(
  type: Y.XmlElement | Y.XmlText,
  stackItem: StackItemLike,
) {
  const store = type.doc?.store?.clients;
  if (!store) return false;

  for (const structs of store.values()) {
    for (const struct of structs) {
      const candidate = itemLike(struct);
      if (candidate.deleted === true || !isDescendantItemOf(candidate, type)) continue;
      if (!isFullyInsideInsertions(candidate, stackItem.insertions)) return true;
    }
  }
  return false;
}

function isUndoContainer(value: unknown): value is Y.XmlElement | Y.XmlText {
  return value instanceof Y.XmlElement || value instanceof Y.XmlText;
}

function isDescendantItemOf(item: ItemLike, ancestor: Y.XmlElement | Y.XmlText): boolean {
  let parent = item.parent;
  while (parent) {
    if (parent === ancestor) return true;
    parent = typeLike(parent)._item?.parent;
  }
  return false;
}

function isFullyInsideInsertions(item: ItemLike, insertions: DeleteSetLike): boolean {
  const ranges = insertions.clients.get(item.id.client) ?? [];
  const start = item.id.clock;
  const end = start + item.length;
  return ranges.some((range) => start >= range.clock && end <= range.clock + range.len);
}

function itemLike(value: unknown): ItemLike {
  return value as ItemLike;
}

function typeLike(value: unknown): TypeLike {
  return value as TypeLike;
}
