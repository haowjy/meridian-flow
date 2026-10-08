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
