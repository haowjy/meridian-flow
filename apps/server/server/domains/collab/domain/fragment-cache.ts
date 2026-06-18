import type { Node as PMNode } from "prosemirror-model";
import type { SchemaType } from "../ports/document-sync.js";
import { blockToMarkdown } from "./schemas.js";

const BLOCK_SEP = "\n\n";

export interface FragmentCache {
  fullMarkdown: string;
}

export function buildFragmentCache(root: PMNode, type: SchemaType): FragmentCache {
  const parts: string[] = [];
  root.forEach((block) => {
    parts.push(blockToMarkdown(type, block));
  });
  return { fullMarkdown: parts.join(BLOCK_SEP) };
}
