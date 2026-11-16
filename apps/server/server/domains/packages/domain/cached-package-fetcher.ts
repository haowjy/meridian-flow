import type { FetchedTree, PackageFetcher } from "../ports/package-fetcher.js";

const MAX_TREES = 8;
const MAX_BYTES = 64 * 1024 * 1024;

const treeBytes = (tree: FetchedTree) =>
  Object.values(tree.files).reduce((sum, file) => sum + file.byteLength, 0);

/**
 * Remembers recent trees by URL and commit so an import's second fetch, which names the commit
 * inspect returned, costs no download. A hit spends none of the caller's budget. Only a request
 * that carries a pin reads the cache. Trees are frozen, so a caller that edits one fails loudly.
 */
export function createCachedPackageFetcher(inner: PackageFetcher): PackageFetcher {
  const trees = new Map<string, { tree: FetchedTree; bytes: number }>();
  let total = 0;
  return {
    async fetchTree(request, budget) {
      const key = (commit: string) => `${request.url}\n${commit}`;
      if (request.pin) {
        const hit = trees.get(key(request.pin.commit));
        if (hit) {
          trees.delete(key(request.pin.commit));
          trees.set(key(request.pin.commit), hit);
          return hit.tree;
        }
      }
      const tree = await inner.fetchTree(request, budget);
      Object.freeze(tree.files);
      Object.freeze(tree.dropped);
      Object.freeze(tree);
      const bytes = treeBytes(tree);
      if (bytes <= MAX_BYTES) {
        const replaced = trees.get(key(tree.commit));
        if (replaced) total -= replaced.bytes;
        trees.delete(key(tree.commit));
        trees.set(key(tree.commit), { tree, bytes });
        total += bytes;
        for (const [oldest, entry] of trees) {
          if (trees.size <= MAX_TREES && total <= MAX_BYTES) break;
          trees.delete(oldest);
          total -= entry.bytes;
        }
      }
      return tree;
    },
  };
}
