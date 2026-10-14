/** Recent history supplies membership; the replica supplies current identity for every Recent surface. */
import {
  catalogViewFromCheckpoint,
  intentOwnsDeletionAt,
  type ResourceProjectionSnapshot,
  resourcePlacementForSnapshot,
} from "@meridian/resource-replica";
import { projectResourceCatalogView } from "@/client/query/useContextCatalog";

/** A resource's current name and path, plus the id it answers to now (an alias resolves to its joined id). */
export type RecentIdentity = { documentId: string; name: string; path: string };

/** Missing means not loaded; null means terminal or optimistically suppressed from Recent. */
export function recentDocumentIdentityIndex(
  projectId: string,
  snapshot: ResourceProjectionSnapshot | null,
): ReadonlyMap<string, RecentIdentity | null> {
  const identities = new Map<string, RecentIdentity | null>();
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
        identities.set(entry.entryId, {
          documentId: entry.entryId,
          name: entry.name,
          path: entry.uri,
        });
    }
  }
  // A joined document's old id is an alias: it answers with the current identity,
  // so one resource is one Recent row whichever id the history remembers.
  for (const { resource } of snapshot.records) {
    const current = identities.get(resource.identity.documentId);
    if (!current) continue;
    for (const alias of Object.keys(resource.aliases)) identities.set(alias, current);
  }
  for (const id of suppressed) if (!identities.has(id)) identities.set(id, null);
  for (const { resource, intents } of snapshot?.records ?? []) {
    if (
      resource.lifecycle.kind === "terminal" ||
      intents.some(
        (intent) =>
          intent.projectId === projectId &&
          intentOwnsDeletionAt(intent, resource.observationVersion),
      ) ||
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
  Map<string, ReadonlyMap<string, RecentIdentity | null>>
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
