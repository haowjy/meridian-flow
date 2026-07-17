/** Project context-tree adapter for markup's stable asset-path resolver port. */
import type { AssetPathResolver } from "@meridian/markup";
import type { ContextListEntry, ContextPort } from "../ports/context-port.js";

export class ContextAssetPathResolver implements AssetPathResolver {
  private readonly pathById = new Map<string, string>();
  private readonly idByPath = new Map<string, string>();

  constructor(private readonly context: Pick<ContextPort, "list">) {}

  /** Refreshes live paths while deliberately retaining missing assets' last-known paths. */
  async refresh(): Promise<void> {
    const entries = await this.context.list("manuscript://assets");
    if (!entries.ok) throw new Error(`Could not load project assets: ${entries.error.code}`);
    for (const entry of entries.value) this.remember(entry);
  }

  pathForAsset(assetDocumentId: string): string {
    const path = this.pathById.get(assetDocumentId);
    if (!path) throw new Error(`No current or last-known path for asset:${assetDocumentId}`);
    return path;
  }

  assetForPath(path: string): string | null {
    return this.idByPath.get(path) ?? null;
  }

  private remember(entry: ContextListEntry): void {
    if (entry.kind !== "file" || !entry.documentId) return;
    const path = projectRelativeAssetPath(entry.uri);
    const previous = this.pathById.get(entry.documentId);
    if (previous) this.idByPath.delete(previous);
    this.pathById.set(entry.documentId, path);
    this.idByPath.set(path, entry.documentId);
  }
}

function projectRelativeAssetPath(uri: string): string {
  const prefix = "manuscript://";
  return uri.startsWith(prefix) ? uri.slice(prefix.length) : uri;
}
