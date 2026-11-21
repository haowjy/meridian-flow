import type { Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import { PROSEMIRROR_FRAGMENT_NAME } from "../model/prosemirror-fragment.js";
import { readRepairedRoot, type SchemaRepairPath } from "../model/schema-repair.js";

/** A fragment's top-level blocks. */
export function readBlocks(fragment: Y.XmlFragment, schema: Schema): PMNode[] {
  const root = readRepairedRoot("readBlocks", fragment, schema);
  const blocks: PMNode[] = [];
  root.forEach((child) => {
    blocks.push(child);
  });
  return blocks;
}

/** A document's top-level blocks as nodes, each converted once per change (`heldBlocks`). */
export interface HeldBlocks {
  /** Every top-level block, in order. */
  all(): PMNode[];
  /** One top-level block; null when the schema cannot build it. */
  of(element: Y.XmlElement): PMNode | null;
}

type Held = { nodes: Map<Y.XmlElement, PMNode>; filled: boolean };

const heldByDoc = new WeakMap<Y.Doc, Map<Schema, Held>>();

/**
 * The document's top-level blocks as ProseMirror nodes, kept across transactions: each
 * transaction forgets only the blocks it changed, and a block not held is converted alone.
 * A writer of one paragraph after another (a draft write's segments, their receipts) then
 * converts each paragraph it touched, not the whole document and every deleted item in it.
 * The first read converts the whole fragment, repairing the document as every read of it does,
 * counted under `path`; a block converted alone is read from a copy of it. Inside a transaction, the blocks
 * it has changed so far are converted afresh on every read.
 */
export function heldBlocks(doc: Y.Doc, schema: Schema, path: Exclude<SchemaRepairPath, "editor">) {
  const held = heldOf(doc, schema);
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  const changedNow = () => {
    const open = doc._transaction;
    return open ? changedBlocks(fragment, open) : NONE;
  };
  const read = (element: Y.XmlElement, changed: ReadonlySet<Y.XmlElement>) => {
    if (changed.has(element)) return convertAlone(element, schema, path);
    let node = held.nodes.get(element);
    if (!node) {
      node = convertAlone(element, schema, path) ?? undefined;
      if (node) held.nodes.set(element, node);
    }
    return node ?? null;
  };
  const fill = () => {
    if (held.filled) return;
    held.filled = true;
    const root = readRepairedRoot(path, fragment, schema);
    // The read deleted what it could not build: the elements left pair with its nodes.
    const elements = topLevel(fragment);
    if (elements.length !== root.childCount) return;
    elements.forEach((element, index) => {
      held.nodes.set(element, root.child(index));
    });
  };
  return {
    all() {
      fill();
      const changed = changedNow();
      return topLevel(fragment).flatMap((element) => read(element, changed) ?? []);
    },
    of(element) {
      fill();
      return read(element, changedNow());
    },
  } satisfies HeldBlocks;
}

const NONE: ReadonlySet<Y.XmlElement> = new Set();

function heldOf(doc: Y.Doc, schema: Schema): Held {
  let bySchema = heldByDoc.get(doc);
  if (!bySchema) {
    const kept = new Map<Schema, Held>();
    bySchema = kept;
    heldByDoc.set(doc, kept);
    const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
    doc.on("afterTransaction", (transaction: Y.Transaction) => {
      const changed = changedBlocks(fragment, transaction);
      const childrenChanged = transaction.changed.has(fragment as never);
      for (const held of kept.values()) {
        for (const element of changed) held.nodes.delete(element);
        if (childrenChanged)
          for (const element of held.nodes.keys())
            if (element._item?.deleted) held.nodes.delete(element);
      }
    });
  }
  let held = bySchema.get(schema);
  if (!held) {
    held = { nodes: new Map(), filled: false };
    bySchema.set(schema, held);
  }
  return held;
}

/** The top-level elements under the types `transaction` changed. */
function changedBlocks(fragment: Y.XmlFragment, transaction: Y.Transaction): Set<Y.XmlElement> {
  const blocks = new Set<Y.XmlElement>();
  for (const type of transaction.changed.keys()) {
    let at = type;
    while (at._item && at._item.parent !== fragment) at = at._item.parent as typeof type;
    if (at._item && at instanceof Y.XmlElement) blocks.add(at);
  }
  return blocks;
}

function topLevel(fragment: Y.XmlFragment): Y.XmlElement[] {
  return fragment.toArray().filter((value): value is Y.XmlElement => value instanceof Y.XmlElement);
}

/** One element read from a copy of it: the binding reads a fragment, and the document's would carry every deleted item. */
function convertAlone(
  element: Y.XmlElement,
  schema: Schema,
  path: Exclude<SchemaRepairPath, "editor">,
): PMNode | null {
  const scratch = new Y.Doc();
  try {
    const fragment = scratch.getXmlFragment("block");
    fragment.insert(0, [element.clone()]);
    return readRepairedRoot(path, fragment, schema).maybeChild(0);
  } finally {
    scratch.destroy();
  }
}
