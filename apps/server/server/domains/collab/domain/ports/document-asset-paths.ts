/** Per-operation image path lookup for the synchronous markup codec. */

import { type AssetPathResolver, unresolvedAssetPathResolver } from "@meridian/markup";

/**
 * Where an image sits is a fact of the document tree, so it is read from there
 * for each operation, never kept: moves, deletes and other processes change it
 * underneath any copy.
 *
 * The codec asks synchronously, so `within` loads the answers first and
 * `resolver` gives them for the rest of that operation. Outside every
 * operation the resolver knows no image: refs stay `asset:` refs and paths
 * stay literal, which is consistent but never what a writer or model sees.
 */
export interface DocumentAssetPaths {
  /** Handed to the codec once; answers from the innermost `within`. */
  readonly resolver: AssetPathResolver;
  /** Run `operation` with the image paths of one project loaded fresh. */
  within<T>(project: AssetPathProject, operation: () => Promise<T>): Promise<T>;
}

/** The project, named directly or by a document or thread in it. */
export type AssetPathProject =
  | { projectId: string }
  | { documentId: string }
  | { threadId: string };

/** For compositions with no project tree (in-memory, tests): no image is known. */
export const NO_DOCUMENT_ASSET_PATHS: DocumentAssetPaths = {
  resolver: unresolvedAssetPathResolver,
  within: (_project, operation) => operation(),
};
