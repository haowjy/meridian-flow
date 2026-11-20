import type { Node as PMNode, Schema } from "prosemirror-model";
import type * as Y from "yjs";
import { readRepairedRoot } from "../model/schema-repair.js";

/** A fragment's top-level blocks. */
export function readBlocks(fragment: Y.XmlFragment, schema: Schema): PMNode[] {
  const root = readRepairedRoot("readBlocks", fragment, schema);
  const blocks: PMNode[] = [];
  root.forEach((child) => {
    blocks.push(child);
  });
  return blocks;
}
