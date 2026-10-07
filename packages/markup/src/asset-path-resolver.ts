/** In-memory asset path resolvers for codec consumers without a project asset namespace. */
import type { AssetPathResolver } from "./types.js";

/** No project namespace: every `asset:` ref stays a ref and every path stays literal. */
export const unresolvedAssetPathResolver: AssetPathResolver = {
  pathForAsset() {
    return null;
  },
  assetForPath() {
    return null;
  },
};

/** A fixed id ↔ path table, for callers that already hold the project's assets. */
export function createAssetPathResolver(
  entries: Iterable<readonly [string, string]>,
): AssetPathResolver {
  const pathById = new Map(entries);
  const idByPath = new Map(Array.from(pathById, ([id, path]) => [path, id]));
  return {
    pathForAsset(assetDocumentId) {
      return pathById.get(assetDocumentId) ?? null;
    },
    assetForPath(path) {
      return idByPath.get(path) ?? null;
    },
  };
}
