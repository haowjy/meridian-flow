/** Thread touch history supplies membership; the replica supplies current file identity. */
import {
  catalogViewFromCheckpoint,
  intentOwnsDeletion,
  projectFolderCatalog,
  type ResourceProjectionSnapshot,
} from "@meridian/resource-replica";
import { projectResourceCatalogView } from "@/client/query/useContextCatalog";

/** Missing means not loaded; null means terminal or optimistically suppressed from Recent. */
export function threadRecentIdentityIndex(
  projectId: string,
  snapshot: ResourceProjectionSnapshot | null,
): ReadonlyMap<string, { name: string; path: string } | null> {
  const identities = new Map<string, { name: string; path: string } | null>();
  for (const catalog of snapshot?.catalogs ?? []) {
    if (catalog.projectId !== projectId) continue;
    const view = projectResourceCatalogView(
      projectId,
      catalog.scope,
      catalogViewFromCheckpoint(catalog),
      snapshot?.records ?? [],
      [],
    );
    const entries = projectFolderCatalog(
      projectId,
      [...view.entries.values()],
      snapshot?.folders ?? [],
    );
    const retained = new Set(entries.map((entry) => entry.entryId));
    for (const [id, entry] of view.entries) {
      if (entry.kind === "file" && !retained.has(id)) identities.set(id, null);
    }
    for (const entry of entries) {
      if (entry.kind === "file")
        identities.set(entry.entryId, { name: entry.name, path: entry.uri });
    }
  }
  for (const { resource, intents } of snapshot?.records ?? []) {
    if (
      resource.lifecycle.kind === "terminal" ||
      intents.some((intent) => intent.projectId === projectId && intentOwnsDeletion(intent))
    )
      identities.set(resource.identity.documentId, null);
  }
  return identities;
}
