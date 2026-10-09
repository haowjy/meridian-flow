/** Per-operation image path lookup for the synchronous markup codec. */

import { type DocumentLinkScope, UNSCOPED_DOCUMENT_LINKS } from "@meridian/markup";

/** Stable asset identity ↔ current manuscript-root-relative path, for one operation. */
export interface AssetPathResolver {
  /**
   * The current (or, once deleted, last) path of an asset document, or null for
   * an id with no document at all. The codec spells null as the `asset:` ref
   * itself, which parses back to the same reference.
   */
  pathForAsset(assetDocumentId: string): string | null;
  /** Return an asset document id only for a path known to the current project. */
  assetForPath(path: string): string | null;
}

/**
 * Where an image sits is a fact of the document tree, so it is read from there
 * for each operation, never kept: moves, deletes and other processes change it
 * underneath any copy.
 *
 * The codec asks synchronously, so `within` loads the answers first and
 * `resolver` gives them for the rest of that operation. Outside every
 * operation the resolver knows no image: refs stay `asset:` refs and paths
 * stay literal, which is consistent but never what a writer or model sees, so
 * the production adapter reports a picture serialized there.
 *
 * The paths are a snapshot taken when the scope opens, before the operation
 * takes its document lock or transaction. A move that lands in between, or one
 * the operation itself makes, shows only in the next scope.
 */
export interface DocumentAssetPaths {
  /** Handed to the codec once; answers from the innermost `within`. */
  readonly resolver: AssetPathResolver;
  /**
   * Run `operation` with the image paths of one project loaded fresh. Nested
   * inside a scope for the same project whose operation is still running, it
   * reuses that scope's paths; work that only inherited a settled scope, such
   * as a timer, loads fresh.
   */
  within<T>(project: AssetPathProject, operation: () => Promise<T>): Promise<T>;
}

/** The project, named directly or by a document or thread in it. */
export type AssetPathProject = (
  | { projectId: string }
  | { documentId: string }
  | { threadId: string }
) & {
  /** Documents already known by the caller to belong to this project (e.g. one source's search). */
  documentIds?: readonly string[];
};

const UNRESOLVED_ASSET_PATHS: AssetPathResolver = {
  pathForAsset: () => null,
  assetForPath: () => null,
};

/** For compositions with no project tree (in-memory, tests): no image is known. */
export const NO_DOCUMENT_ASSET_PATHS: DocumentAssetPaths = {
  resolver: UNRESOLVED_ASSET_PATHS,
  within: (_project, operation) => operation(),
};

/**
 * Transitional (#729/#730 lane F2 deletes it with this port): the serialize
 * scope the codec spells through until the server has a holder-bound document
 * link scope. Links spell their stored href; an `asset:` source spells the
 * path the innermost `within` knows it by, else the ref itself.
 */
export function assetPathLinkScope(resolver: AssetPathResolver): DocumentLinkScope {
  return {
    spellLink: UNSCOPED_DOCUMENT_LINKS.spellLink,
    spellSource(attrs) {
      const path = attrs.src.startsWith("asset:")
        ? resolver.pathForAsset(attrs.src.slice("asset:".length))
        : null;
      return path ? { href: path, address: null } : UNSCOPED_DOCUMENT_LINKS.spellSource(attrs);
    },
  };
}
