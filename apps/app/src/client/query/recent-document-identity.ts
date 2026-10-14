/** Recent history supplies membership; the replica supplies current identity for every Recent surface. */
import {
  catalogViewFromCheckpoint,
  intentOwnsDeletionAt,
  type ResourceProjectionSnapshot,
  resourceIdentityIndex,
  resourcePlacementForSnapshot,
} from "@meridian/resource-replica";
import { projectResourceCatalogView } from "@/client/query/useContextCatalog";

/** A resource's current name and path, plus the id it answers to now (an alias resolves to its joined id). */
export type RecentIdentity = { documentId: string; name: string; path: string };

/** Undefined means not loaded; null means terminal or optimistically suppressed from Recent. */
export type RecentIdentities = { get(documentId: string): RecentIdentity | null | undefined };

const noIdentities: RecentIdentities = { get: () => undefined };

export function recentDocumentIdentityIndex(
  projectId: string,
  snapshot: ResourceProjectionSnapshot | null,
): RecentIdentities {
  if (!snapshot) return noIdentities;
  const cached = indexes.get(snapshot)?.get(projectId);
  if (cached) return cached;
  const identities = new Map<string, RecentIdentity | null>();
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
  // The record answers first, so a joined document's old id inherits its resource's current
  // identity and its terminal or hidden result: one resource is one Recent row.
  const records = resourceIdentityIndex(snapshot.records);
  const resolved: RecentIdentities = {
    get: (documentId) =>
      identities.get(records.byDocumentId(documentId)?.resource.identity.documentId ?? documentId),
  };
  let projects = indexes.get(snapshot);
  if (!projects) {
    projects = new Map();
    indexes.set(snapshot, projects);
  }
  projects.set(projectId, resolved);
  return resolved;
}

const indexes = new WeakMap<ResourceProjectionSnapshot, Map<string, RecentIdentities>>();

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
