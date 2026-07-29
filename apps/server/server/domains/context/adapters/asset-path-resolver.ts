/** Project context-tree adapter for markup's stable asset-path resolver port. */

import type { Database } from "@meridian/database";
import { contextSources, documents, folders } from "@meridian/database/schema";
import type { AssetPathResolver } from "@meridian/markup";
import { and, eq, isNull } from "drizzle-orm";

export type MutableAssetPathResolver = AssetPathResolver & {
  remember(assetDocumentId: string, path: string): void;
};

/**
 * `pathForAsset` is unambiguous because asset document ids are unique. The
 * reverse is not: two projects may both hold `assets/map.png`, and handing a
 * codec the wrong project's asset id would plant a reference that can never
 * resolve. An ambiguous path therefore resolves to nothing and stays literal.
 */
class AssetPathIndex implements MutableAssetPathResolver {
  private readonly pathById = new Map<string, string>();
  private readonly idsByPath = new Map<string, Set<string>>();

  pathForAsset(assetDocumentId: string): string {
    const path = this.pathById.get(assetDocumentId);
    if (!path) throw new Error(`No current or last-known path for asset:${assetDocumentId}`);
    return path;
  }

  assetForPath(path: string): string | null {
    const ids = this.idsByPath.get(path);
    if (ids?.size !== 1) return null;
    return [...ids][0] ?? null;
  }

  remember(assetDocumentId: string, path: string): void {
    const previous = this.pathById.get(assetDocumentId);
    if (previous) this.idsByPath.get(previous)?.delete(assetDocumentId);
    this.pathById.set(assetDocumentId, path);
    const ids = this.idsByPath.get(path) ?? new Set<string>();
    ids.add(assetDocumentId);
    this.idsByPath.set(path, ids);
  }
}

/** Loads the persisted manuscript assets used by production codec composition. */
export async function createDrizzleAssetPathResolver(
  db: Database,
): Promise<MutableAssetPathResolver> {
  const rows = await db
    .select({
      assetDocumentId: documents.id,
      name: documents.name,
      extension: documents.extension,
    })
    .from(documents)
    .innerJoin(folders, eq(documents.folderId, folders.id))
    .innerJoin(contextSources, eq(documents.contextSourceId, contextSources.id))
    .where(
      and(
        eq(contextSources.slug, "manuscript"),
        eq(folders.name, "assets"),
        isNull(folders.parentId),
        isNull(documents.deletedAt),
        isNull(folders.deletedAt),
        isNull(contextSources.deletedAt),
      ),
    );
  const resolver = new AssetPathIndex();
  for (const row of rows) {
    resolver.remember(
      row.assetDocumentId,
      `assets/${row.name}${row.extension ? `.${row.extension}` : ""}`,
    );
  }
  return resolver;
}
