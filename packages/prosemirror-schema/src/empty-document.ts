import type { Node as PMNode, Schema } from "prosemirror-model";

import { newBlockId } from "./block-id.js";

export function blankDocument(schema: Schema): PMNode[] {
  return [schema.nodes.paragraph.create({ id: newBlockId() })];
}

export function isEmptyDocument(blocks: readonly PMNode[]): boolean {
  if (blocks.length === 0) return true;
  const [only] = blocks;
  return (
    blocks.length === 1 &&
    only.type.name === "paragraph" &&
    only.content.size === 0 &&
    Object.entries(only.attrs).every(([name, value]) => name === "id" || value === null)
  );
}
