/** Identity-preserving Markdown snapshot assembly shared by worker and synchronous adapters. */

import type { Node as PMNode } from "@tiptap/pm/model";

export type NodePath = { block: number; path: number[] } | null;

export type MarkdownSnapshot<T> = {
  source: string;
  blocks: readonly T[];
  openCode: NodePath;
};

export type SnapshotUpdate = {
  source: string;
  keys: string[];
  nodes: Record<string, unknown>;
  evicted: string[];
  openCode: NodePath;
};

const HISTORY_LIMIT = 128;

export class MarkdownParseSession<T> {
  readonly #entries = new Map<string, { json: string; value: T }>();

  capture(
    source: string,
    blocks: readonly PMNode[],
    openCode: PMNode | null,
    valueFor: (block: PMNode) => T,
  ): { snapshot: MarkdownSnapshot<T>; update: SnapshotUpdate } {
    const keys: string[] = [];
    const nodes: Record<string, unknown> = {};
    for (const block of blocks) {
      const jsonValue = block.toJSON();
      const json = JSON.stringify(jsonValue);
      const key = this.#contentKey(json);
      keys.push(key);
      if (!this.#entries.has(key)) {
        const value = valueFor(block);
        this.#entries.set(key, { json, value });
        nodes[key] = jsonValue;
      } else {
        const entry = this.#entries.get(key) as { json: string; value: T };
        this.#entries.delete(key);
        this.#entries.set(key, entry);
      }
    }

    const current = new Set(keys);
    const evicted: string[] = [];
    for (const key of this.#entries.keys()) {
      if (this.#entries.size <= current.size + HISTORY_LIMIT) break;
      if (current.has(key)) continue;
      this.#entries.delete(key);
      evicted.push(key);
    }
    const locator = nodePath(blocks, openCode);
    return {
      snapshot: {
        source,
        blocks: keys.map((key) => (this.#entries.get(key) as { value: T }).value),
        openCode: locator,
      },
      update: { source, keys, nodes, evicted, openCode: locator },
    };
  }

  apply(update: SnapshotUpdate, valueFor: (json: unknown) => T): MarkdownSnapshot<T> | null {
    for (const key of update.evicted) this.#entries.delete(key);
    for (const [key, jsonValue] of Object.entries(update.nodes)) {
      this.#entries.set(key, { json: JSON.stringify(jsonValue), value: valueFor(jsonValue) });
    }
    const blocks = update.keys.map((key) => this.#entries.get(key)?.value);
    return blocks.some((block) => block === undefined)
      ? null
      : { source: update.source, blocks: blocks as T[], openCode: update.openCode };
  }

  #contentKey(json: string): string {
    const base = `${hash(json)}:${json.length}`;
    for (let collision = 0; ; collision++) {
      const key = collision === 0 ? base : `${base}:${collision}`;
      const known = this.#entries.get(key)?.json;
      if (known === undefined || known === json) return key;
    }
  }
}

export function nodePath(blocks: readonly PMNode[], target: PMNode | null): NodePath {
  if (!target) return null;
  for (let block = 0; block < blocks.length; block++) {
    const root = blocks[block];
    if (!root) continue;
    const path = descendantPath(root, target);
    if (path) return { block, path };
  }
  return null;
}

export function nodeAtPath<T extends { maybeChild(index: number): T | null }>(
  blocks: readonly T[],
  locator: NodePath,
): T | null {
  if (!locator) return null;
  let node = blocks[locator.block];
  if (!node) return null;
  for (const index of locator.path) {
    const child = node.maybeChild(index);
    if (!child) return null;
    node = child;
  }
  return node;
}

export function reconcileSnapshot<
  T extends { eq(other: T): boolean; maybeChild(index: number): T | null },
>(next: MarkdownSnapshot<T>, previous: MarkdownSnapshot<T> | null): MarkdownSnapshot<T> {
  if (!previous) return next;
  return {
    ...next,
    blocks: next.blocks.map((node, index) => {
      const old = previous.blocks[index];
      return old?.eq(node) ? old : node;
    }),
  };
}

function descendantPath(node: PMNode, target: PMNode): number[] | null {
  if (node === target) return [];
  for (let index = 0; index < node.childCount; index++) {
    const path = descendantPath(node.child(index), target);
    if (path) return [index, ...path];
  }
  return null;
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(36);
}
