import type { Node as PMNode } from "prosemirror-model";
import type { SchemaType } from "../ports/document-sync.js";
import { nodeToMdx } from "./schemas.js";

export interface FragmentCache {
  fullMarkdown: string;
}

export function buildFragmentCache(root: PMNode, type: SchemaType): FragmentCache {
  return { fullMarkdown: nodeToMdx(type, root) };
}
