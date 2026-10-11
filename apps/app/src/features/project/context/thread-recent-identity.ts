/** Thread touch history supplies membership; the replica supplies current file identity. */
import type { ThreadRecentDocumentItem } from "@meridian/contracts/protocol";
import {
  catalogViewFromCheckpoint,
  type ResourceProjectionSnapshot,
} from "@meridian/resource-replica";
import { projectResourceCatalogView } from "@/client/query/useContextCatalog";

export function threadRecentIdentity(
  projectId: string,
  document: ThreadRecentDocumentItem,
  snapshot: ResourceProjectionSnapshot | null,
): { name: string; path: string } {
  for (const catalog of snapshot?.catalogs ?? []) {
    if (catalog.projectId !== projectId) continue;
    const view = projectResourceCatalogView(
      projectId,
      catalog.scope,
      catalogViewFromCheckpoint(catalog),
      snapshot?.records ?? [],
      snapshot?.folders ?? [],
    );
    const entry = view.entries.get(document.documentId);
    if (entry?.kind === "file") return { name: entry.name, path: entry.uri };
  }
  const name = `${document.name}${document.extension ? `.${document.extension.replace(/^\./, "")}` : ""}`;
  return { name, path: name };
}
