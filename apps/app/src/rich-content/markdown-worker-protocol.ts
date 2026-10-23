/** Messages shared by the Markdown worker and its main-thread cache. */

import type { Node as PMNode } from "@tiptap/pm/model";

export type OpenCodePath = { block: number; path: number[] } | null;

export type MarkdownWorkerRequest =
  | { type: "parse"; streamId: string; generation: number; seq: number; source: string }
  | { type: "release"; streamId: string; generation: number };

export type MarkdownWorkerResponse =
  | {
      type: "result";
      streamId: string;
      generation: number;
      seq: number;
      source: string;
      keys: string[];
      nodes: Record<string, unknown>;
      evicted: string[];
      openCode: OpenCodePath;
    }
  | { type: "error"; streamId: string; generation: number; seq: number; message: string };

export function nodePath(blocks: readonly PMNode[], target: PMNode | null): OpenCodePath {
  if (!target) return null;
  for (let block = 0; block < blocks.length; block++) {
    const root = blocks[block];
    if (!root) continue;
    const path = descendantPath(root, target);
    if (path) return { block, path };
  }
  return null;
}

export function nodeAtPath(blocks: readonly PMNode[], locator: OpenCodePath): PMNode | null {
  if (!locator) return null;
  let node: PMNode | undefined = blocks[locator.block];
  if (!node) return null;
  for (const index of locator.path) {
    node = node.maybeChild(index) ?? undefined;
    if (!node) return null;
  }
  return node;
}

function descendantPath(node: PMNode, target: PMNode): number[] | null {
  if (node === target) return [];
  for (let index = 0; index < node.childCount; index++) {
    const path = descendantPath(node.child(index), target);
    if (path) return [index, ...path];
  }
  return null;
}
