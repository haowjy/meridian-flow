/**
 * The schema repair: building ProseMirror nodes from Yjs makes y-prosemirror delete any element
 * the schema cannot build (an unknown node name, content the schema refuses), and the nodes
 * leave it out. That delete is the repair. Every read of a fragment in this package goes
 * through `readRepairedRoot`, and the editor's witness reports its own repairs here, so each
 * path counts where it fires and nowhere else.
 */
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type { Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";

export type SchemaRepairPath = "editor" | "projectBlocks" | "readBlocks";

const fired: Record<SchemaRepairPath, number> = { editor: 0, projectBlocks: 0, readBlocks: 0 };

/** One read that deleted something counts once: how often the repair fired on each path, in this process. */
export function schemaRepairCounts(): Readonly<Record<SchemaRepairPath, number>> {
  return { ...fired };
}

export function countSchemaRepair(path: SchemaRepairPath): void {
  fired[path] += 1;
}

function deletedClocks(deleteSet: Y.Transaction["deleteSet"]): number {
  let total = 0;
  for (const ranges of deleteSet.clients.values()) for (const range of ranges) total += range.len;
  return total;
}

/**
 * The fragment as a ProseMirror root, with the binding's repair counted under `path`. The read
 * runs in one transaction, so a repair inside a caller's own transaction (a capture, a write)
 * still shows as a change of that transaction's delete set.
 */
export function readRepairedRoot(
  path: Exclude<SchemaRepairPath, "editor">,
  fragment: Y.XmlFragment,
  schema: Schema,
): PMNode {
  const doc = fragment.doc;
  if (!doc) return yXmlFragmentToProseMirrorRootNode(fragment, schema);
  let root: PMNode | undefined;
  doc.transact((transaction) => {
    const before = deletedClocks(transaction.deleteSet);
    root = yXmlFragmentToProseMirrorRootNode(fragment, schema);
    if (deletedClocks(transaction.deleteSet) > before) countSchemaRepair(path);
  });
  return root as PMNode;
}

function insideUnbuildableElement(item: Y.Item, schema: Schema): boolean {
  for (let node: Y.Item | null = item; node; ) {
    const content = node.content;
    if (
      content instanceof Y.ContentType &&
      content.type instanceof Y.XmlElement &&
      !(content.type.nodeName in schema.nodes)
    ) {
      return true;
    }
    node = (node.parent as Y.AbstractType<unknown> | null)?._item ?? null;
  }
  return false;
}

/**
 * Whether `update` is only the binding's schema repair of this room: it adds nothing and every
 * item it deletes is, or sits inside, an element whose node name the schema lacks. No writer
 * asked for it, so the server journals it under no name. A repair of an element the schema
 * knows but refuses the content of (a block inside a paragraph) is not recognised.
 */
export function isSchemaRepairUpdate(room: Y.Doc, update: Uint8Array, schema: Schema): boolean {
  const { structs, ds } = Y.decodeUpdate(update);
  if (structs.length > 0 || ds.clients.size === 0) return false;
  for (const [client, ranges] of ds.clients) {
    for (const { clock, len } of ranges) {
      for (let at = clock; at < clock + len; ) {
        // A delete of an item the room has not seen is no repair of this room's.
        if (at >= Y.getState(room.store, client)) return false;
        const item = Y.getItem(room.store, Y.createID(client, at));
        if (!(item instanceof Y.Item) || !insideUnbuildableElement(item, schema)) return false;
        at = item.id.clock + item.length;
      }
    }
  }
  return true;
}
