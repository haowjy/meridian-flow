/** Recent history supplies membership; the replica supplies current identity for every Recent surface. */
import {
  catalogViewFromCheckpoint,
  intentOwnsDeletion,
  type ResourceProjectionSnapshot,
  resourcePlacementForSnapshot,
} from "@meridian/resource-replica";
import { projectResourceCatalogView } from "@/client/query/useContextCatalog";

/** Missing means not loaded; null means terminal or optimistically suppressed from Recent. */
export function recentDocumentIdentityIndex(
  projectId: string,
  snapshot: ResourceProjectionSnapshot | null,
): ReadonlyMap<string, { name: string; path: string } | null> {
  const identities = new Map<string, { name: string; path: string } | null>();
  if (!snapshot) return identities;
  const cached = indexes.get(snapshot)?.get(projectId);
  if (cached) return cached;
  const placement = resourcePlacementForSnapshot(projectId, snapshot);
  const suppressed = new Set<string>();
  for (const catalog of snapshot.catalogs) {
    if (catalog.projectId !== projectId) continue;
    const view = projectResourceCatalogView(
      projectId,
      catalog.scope,
      catalogViewFromCheckpoint(catalog),
      snapshot?.records ?? [],
      placement,
    );
    const entries = [...view.entries.values()];
    const retained = new Set(entries.map((entry) => entry.entryId));
    for (const entry of catalog.entries) {
      if (entry.kind === "file" && !retained.has(entry.entryId)) suppressed.add(entry.entryId);
    }
    for (const entry of entries) {
      if (entry.kind === "file")
        identities.set(entry.entryId, { name: entry.name, path: entry.uri });
    }
  }
  for (const id of suppressed) if (!identities.has(id)) identities.set(id, null);
  for (const { resource, intents } of snapshot?.records ?? []) {
    if (
      resource.lifecycle.kind === "terminal" ||
      intents.some((intent) => intent.projectId === projectId && intentOwnsDeletion(intent)) ||
      !placement.resourceLocation({ resource, intents })
    )
      identities.set(resource.identity.documentId, null);
  }
  let projects = indexes.get(snapshot);
  if (!projects) {
    projects = new Map();
    indexes.set(snapshot, projects);
  }
  projects.set(projectId, identities);
  return identities;
}

const indexes = new WeakMap<
  ResourceProjectionSnapshot,
  Map<string, ReadonlyMap<string, { name: string; path: string } | null>>
>();

/** Only accepted deletion changes refetch the server list; pending intent stays local. */
export function recentDeletionRevision(
  projectId: string,
  snapshot: ResourceProjectionSnapshot | null,
): string {
  if (!snapshot) return "";
  return JSON.stringify(
    [
      ...snapshot.records.flatMap(({ resource }) =>
        resource.lifecycle.kind === "terminal" ? [resource.lifecycle.transitionId] : [],
      ),
      ...snapshot.folders
        .filter((folder) => folder.projectId === null || folder.projectId === projectId)
        .flatMap((folder) =>
          folder.intents
            .filter((intent) => intent.desired.kind === "delete" && intent.state === "settled")
            .map((intent) => intent.intentId),
        ),
    ].sort(),
  );
}
