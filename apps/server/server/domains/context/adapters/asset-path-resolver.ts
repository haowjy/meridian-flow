/** Project context-tree adapter for markup's stable asset-path resolver port. */

import type { Database } from "@meridian/database";
import { contextSources, documents, folders } from "@meridian/database/schema";
import type { AssetPathResolver } from "@meridian/markup";
import { and, eq, isNull } from "drizzle-orm";
import type { ContextListEntry, ContextPort } from "../ports/context-port.js";

class AssetPathIndex implements AssetPathResolver {
  private readonly pathById = new Map<string, string>();
  private readonly idByPath = new Map<string, string>();

  pathForAsset(assetDocumentId: string): string {
    const path = this.pathById.get(assetDocumentId);
    if (!path) throw new Error(`No current or last-known path for asset:${assetDocumentId}`);
    return path;
  }

  assetForPath(path: string): string | null {
    return this.idByPath.get(path) ?? null;
  }

  remember(assetDocumentId: string, path: string): void {
    const previous = this.pathById.get(assetDocumentId);
    if (previous) this.idByPath.delete(previous);
    this.pathById.set(assetDocumentId, path);
    this.idByPath.set(path, assetDocumentId);
  }
}

export class ContextAssetPathResolver extends AssetPathIndex {
  constructor(private readonly context: Pick<ContextPort, "list">) {
    super();
  }

  /** Refreshes live paths while deliberately retaining missing assets' last-known paths. */
  async refresh(): Promise<void> {
    const entries = await this.context.list("manuscript://assets");
    if (!entries.ok) throw new Error(`Could not load project assets: ${entries.error.code}`);
    for (const entry of entries.value) this.rememberEntry(entry);
  }

  private rememberEntry(entry: ContextListEntry): void {
    if (entry.kind !== "file" || !entry.documentId) return;
    const path = projectRelativeAssetPath(entry.uri);
    this.remember(entry.documentId, path);
  }
}

export type MutableAssetPathResolver = AssetPathResolver & {
  remember(assetDocumentId: string, path: string): void;
};

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
  const entries = rows.map(
    (row) =>
      [
        row.assetDocumentId,
        `assets/${row.name}${row.extension ? `.${row.extension}` : ""}`,
      ] as const,
  );
  const resolver = new AssetPathIndex();
  for (const [id, path] of entries) resolver.remember(id, path);
  return resolver;
}

function projectRelativeAssetPath(uri: string): string {
  const prefix = "manuscript://";
  return uri.startsWith(prefix) ? uri.slice(prefix.length) : uri;
}
