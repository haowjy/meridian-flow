import type { Node as PMNode } from "prosemirror-model";
import type { SchemaType } from "../ports/document-sync.js";
import { blockToMarkdown } from "./schemas.js";

const BLOCK_SEP = "\n\n";

export interface FragmentEntry {
  nodeIndex: number;
  markdownOffset: number;
  pmPosition: number;
  markdown: string;
}

export interface FragmentCache {
  entries: FragmentEntry[];
  fullMarkdown: string;
}

export function buildFragmentCache(root: PMNode, type: SchemaType): FragmentCache {
  const entries: FragmentEntry[] = [];
  let markdownOffset = 0;

  root.forEach((block, pmPosition, nodeIndex) => {
    const markdown = blockToMarkdown(type, block);
    entries.push({ nodeIndex, markdownOffset, pmPosition, markdown });
    markdownOffset += markdown.length + BLOCK_SEP.length;
  });

  return { entries, fullMarkdown: entries.map((entry) => entry.markdown).join(BLOCK_SEP) };
}
