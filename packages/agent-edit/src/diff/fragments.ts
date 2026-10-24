/** The draft room's reserved review-base root and how to read a fragment's top-level blocks. */
import type { Node as PMNode, Schema } from "prosemirror-model";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import type * as Y from "yjs";

/** One name for the server-owned root, shared by server admission, the rebase writer and the browser. */
export const REVIEW_BASE_FRAGMENT = "review_base";

export function readBlocks(fragment: Y.XmlFragment, schema: Schema): PMNode[] {
  const root = yXmlFragmentToProseMirrorRootNode(fragment, schema);
  const blocks: PMNode[] = [];
  root.forEach((child) => {
    blocks.push(child);
  });
  return blocks;
}
