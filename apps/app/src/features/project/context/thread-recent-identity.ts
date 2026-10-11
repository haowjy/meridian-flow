/** Thread touch history supplies membership; the replica supplies current file identity. */
import {
  catalogViewFromCheckpoint,
  type ResourceProjectionSnapshot,
} from "@meridian/resource-replica";
import { projectResourceCatalogView } from "@/client/query/useContextCatalog";

/** Missing means not loaded; null means proven terminal and must not appear in Recent. */
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
      snapshot?.folders ?? [],
    );
    for (const [id, entry] of view.entries) {
      if (entry.kind === "file") identities.set(id, { name: entry.name, path: entry.uri });
    }
  }
  for (const { resource } of snapshot?.records ?? []) {
    if (resource.lifecycle.kind === "terminal") identities.set(resource.identity.documentId, null);
  }
  return identities;
}
