/** Folder canonical locations follow the catalog observation that proves them, in the same commit. */
import { newerCanonicalObservation } from "./canonical-observation";
import type { CatalogCacheView } from "./catalog";
import {
  type CatalogObservationFence,
  catalogEntryLocation,
  catalogEntryParent,
  catalogViewFromCheckpoint,
  sameResourceLocation,
} from "./catalog-installation";
import { installFolderCanonicalRefresh } from "./folder-namespace";
import type {
  FolderNamespaceRecord,
  FolderNamespaceWrite,
  ParentRef,
  ResourceCatalogCheckpoint,
  ResourceLocation,
} from "./resource-records";

/** A folder's server-canonical location: the installed catalog's, never an optimistic projection. */
export function installedFolderObservation(
  catalogs: readonly ResourceCatalogCheckpoint[],
  projectId: string,
  folderId: string,
): { location: ResourceLocation; parent: ParentRef; observationVersion: string } | null {
  for (const checkpoint of catalogs) {
    if (checkpoint.projectId !== projectId) continue;
    const view = catalogViewFromCheckpoint(checkpoint);
    const entry = view.entries.get(folderId);
    if (entry?.kind === "folder") {
      const location = catalogEntryLocation(view, entry);
      return {
        location,
        parent: catalogEntryParent(entry, location),
        observationVersion: entry.observationVersion,
      };
    }
  }
  return null;
}

export function folderObservationFence(
  folders: readonly FolderNamespaceRecord[],
): NonNullable<CatalogObservationFence["folders"]> {
  return new Map(
    folders.map((record) => [
      record.handle,
      {
        revision: record.revision,
        canonical: structuredClone(record.canonical),
        refreshOperationId: record.canonicalRefresh?.operationId,
      },
    ]),
  );
}

/**
 * A folder record is installed only when it was already known before the request:
 * a later record or a barrier set after the request has no proof in this view.
 * A barrier clears only for the operation id the fence saw.
 */
export function planFolderCatalogInstallation(input: {
  projectId: string;
  folders: readonly FolderNamespaceRecord[];
  view: CatalogCacheView;
  fence: CatalogObservationFence;
}): FolderNamespaceWrite[] {
  const writes: FolderNamespaceWrite[] = [];
  const known = new Set(input.folders.map((record) => record.folderId));
  // Retain canonical ancestry even if its checkpoint is later absent (for example in Recent).
  for (const entry of input.view.entries.values()) {
    if (entry.kind !== "folder" || entry.navigationOnly || known.has(entry.entryId)) continue;
    const location = catalogEntryLocation(input.view, entry);
    writes.push({
      expectedRevision: null,
      next: {
        handle: `folder:${entry.entryId}`,
        folderId: entry.entryId,
        projectId: location.scheme === "user" ? null : input.projectId,
        revision: 1,
        serverHold: "held",
        canonical: location,
        observationVersion: entry.observationVersion,
        canonicalParent: catalogEntryParent(entry, location),
        canonicalRank: entry.rank,
        canonicalLocationVersion: entry.locationVersion,
        canonicalOrderPolicy: entry.orderPolicy,
        intents: [],
      },
    });
  }
  for (const record of input.folders) {
    if (record.projectId !== null && record.projectId !== input.projectId) continue;
    const entry = input.view.entries.get(record.folderId);
    const observed = input.fence.folders?.get(record.handle);
    // A local folder gains its place from its own create's answer, never from a catalog read.
    if (!record.canonical) continue;
    if (entry?.kind !== "folder" || !observed || observed.revision !== record.revision) continue;
    const location = catalogEntryLocation(input.view, entry);
    if (record.canonicalRefresh) {
      if (observed.refreshOperationId !== record.canonicalRefresh.operationId) continue;
      const write = installFolderCanonicalRefresh(
        record,
        record.canonicalRefresh.operationId,
        location,
        catalogEntryParent(entry, location),
        entry.observationVersion,
        entry.rank,
        entry.orderPolicy,
        entry.locationVersion,
      );
      if (write) writes.push(write);
      continue;
    }
    // Equal or older evidence never revives a deletion; held versions include the deletion's.
    if (!newerCanonicalObservation(entry.observationVersion, record.observationVersion)) continue;
    if (!sameResourceLocation(observed.canonical, record.canonical)) continue;
    // A strictly newer present observation is a later restore: it clears the terminal witness,
    // and the held version it installs retires an accepted delete's ownership.
    const { terminal: _superseded, ...present } = record;
    writes.push({
      expectedRevision: record.revision,
      next: {
        ...present,
        revision: record.revision + 1,
        canonical: location,
        observationVersion: entry.observationVersion,
        canonicalParent: catalogEntryParent(entry, location),
        canonicalRank: entry.rank,
        canonicalLocationVersion: entry.locationVersion,
        canonicalOrderPolicy: entry.orderPolicy,
      },
    });
  }
  return writes;
}
