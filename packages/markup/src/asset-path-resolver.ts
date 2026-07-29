/** Explicit adapter for codec consumers that have no project asset namespace. */
import type { AssetPathResolver } from "./types.js";

export const unresolvedAssetPathResolver: AssetPathResolver = {
  pathForAsset(assetDocumentId) {
    throw new Error(`Cannot serialize asset:${assetDocumentId} without a project asset index`);
  },
  assetForPath() {
    return null;
  },
};

/** Minimal in-memory adapter used after a project asset index has been loaded. */
export function createAssetPathResolver(
  entries: Iterable<readonly [string, string]>,
): AssetPathResolver {
  const pathById = new Map(entries);
  const idByPath = new Map(Array.from(pathById, ([id, path]) => [path, id]));
  return {
    pathForAsset(assetDocumentId) {
      const path = pathById.get(assetDocumentId);
      if (!path) throw new Error(`No current or last-known path for asset:${assetDocumentId}`);
      return path;
    },
    assetForPath(path) {
      return idByPath.get(path) ?? null;
    },
  };
}
