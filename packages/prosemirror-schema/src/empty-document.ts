/**
 * The empty document. The editor cannot show zero blocks, so a document with no blocks and one
 * plain empty paragraph are the same document: this is the one reading of both encodings.
 */
import type { Node as PMNode, Schema } from "prosemirror-model";

import { newBlockId } from "./block-id.js";

/** What a document with no text holds once an editor has opened it: one paragraph with a fresh id. */
export function blankDocument(schema: Schema): PMNode[] {
  return [schema.nodes.paragraph.create({ id: newBlockId() })];
}

/**
 * Whether the blocks are the empty document: none, or one paragraph with no content and no
 * attribute but its id (a heading, list item or aligned paragraph is something the writer made).
 */
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
