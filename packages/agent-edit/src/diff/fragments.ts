import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import type { Node as PMNode, Schema } from "prosemirror-model";
import * as Y from "yjs";
import { getTopLevelXmlBlocks } from "../model/block-hash.js";
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

type Held = { nodes: Map<Y.XmlElement, PMNode>; filled: boolean };

const heldByDoc = new WeakMap<Y.Doc, Map<Schema, Held>>();

/**
 * The document's top-level blocks as ProseMirror nodes, kept between transactions: each
 * transaction forgets the blocks it changed, and the next read converts a block it doesn't hold
 * alone, from a copy. A writer of one paragraph after another (a draft write's segments, their
 * receipts) then converts each paragraph it touched, not the whole document and every deleted
 * item in it. Nodes are stored only while no transaction is open: Yjs records a change to a
 * block in `transaction.changed` only when the block existed before the transaction, so a block
 * held from before is the only kind whose changes it sees. Inside a transaction, a block it has
 * changed, or one not held, is converted on every read. A read repairs the document as
 * `readRepairedRoot` does, counted under `path`: the first read converts the whole fragment, and
 * a block whose copy needed repair is read with the whole fragment again.
 */
export function heldBlocks(doc: Y.Doc, schema: Schema, path: Exclude<SchemaRepairPath, "editor">) {
  const held = heldOf(doc, schema);
  const fragment = doc.getXmlFragment(PROSEMIRROR_FRAGMENT_NAME);
  /** The whole fragment, repaired; stored when no transaction is open. */
  const readWhole = (): Map<Y.XmlElement, PMNode> => {
    const root = readRepairedRoot(path, fragment, schema);
    // The read deleted what it could not build: the elements left pair with its nodes.
    const elements = getTopLevelXmlBlocks(doc);
    if (elements.length !== root.childCount)
      throw new Error(
        `Projection lost alignment: ${elements.length} elements for ${root.childCount} nodes`,
      );
    const nodes = new Map(elements.map((element, index) => [element, root.child(index)]));
    if (!doc._transaction) {
      held.nodes = nodes;
      held.filled = true;
    }
    return nodes;
  };
  const read = (elements: readonly Y.XmlElement[]): PMNode[] => {
    const fromWhole = () => {
      const whole = readWhole();
      return elements.flatMap((element) => whole.get(element) ?? []);
    };
    if (!held.filled) return fromWhole();
    const open = doc._transaction;
    const changed = open ? changedBlocks(fragment, open) : NONE;
    const nodes: PMNode[] = [];
    for (const element of elements) {
      let node = changed.has(element) ? undefined : held.nodes.get(element);
      if (!node) {
        const alone = convertAlone(element, schema);
        if (!alone) return fromWhole();
        node = alone;
        if (!open) held.nodes.set(element, node);
      }
      nodes.push(node);
    }
    return nodes;
  };
  return {
    /** Every top-level block, in order. */
    all: (): PMNode[] => read(getTopLevelXmlBlocks(doc)),
    /** One top-level block; null when the read repaired it away. */
    of: (element: Y.XmlElement): PMNode | null => read([element])[0] ?? null,
  };
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

/**
 * One element read from a copy of it (the binding reads a fragment, and the document's would
 * carry every deleted item). Null when the copy needed repair, which only a read of the
 * document itself may make.
 */
function convertAlone(element: Y.XmlElement, schema: Schema): PMNode | null {
  const scratch = new Y.Doc();
  try {
    const fragment = scratch.getXmlFragment("block");
    fragment.insert(0, [element.clone()]);
    let repaired = false;
    scratch.on("update", () => {
      repaired = true;
    });
    const node = yXmlFragmentToProseMirrorRootNode(fragment, schema).maybeChild(0);
    return repaired ? null : node;
  } finally {
    scratch.destroy();
  }
}
