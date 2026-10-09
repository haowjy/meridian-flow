/** Folder canonical locations follow the catalog observation that proves them, in the same commit. */
import type { CatalogCacheView } from "./catalog";
import {
  type CatalogObservationFence,
  catalogEntryLocation,
  catalogViewFromCheckpoint,
  sameResourceLocation,
} from "./catalog-installation";
import { installFolderCanonicalRefresh } from "./folder-namespace";
import type {
  FolderNamespaceRecord,
  FolderNamespaceWrite,
  ResourceCatalogCheckpoint,
  ResourceLocation,
} from "./resource-records";

/** A folder's server-canonical location: the installed catalog's, never an optimistic projection. */
export function installedFolderLocation(
  catalogs: readonly ResourceCatalogCheckpoint[],
  projectId: string,
  folderId: string,
): ResourceLocation | null {
  for (const checkpoint of catalogs) {
    if (checkpoint.projectId !== projectId) continue;
    const view = catalogViewFromCheckpoint(checkpoint);
    const entry = view.entries.get(folderId);
    if (entry?.kind === "folder") return catalogEntryLocation(view, entry);
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
  for (const record of input.folders) {
    if (record.projectId !== null && record.projectId !== input.projectId) continue;
    const entry = input.view.entries.get(record.folderId);
    const observed = input.fence.folders?.get(record.handle);
    if (entry?.kind !== "folder" || !observed) continue;
    const location = catalogEntryLocation(input.view, entry);
    if (record.canonicalRefresh) {
      if (observed.refreshOperationId !== record.canonicalRefresh.operationId) continue;
      const write = installFolderCanonicalRefresh(
        record,
        record.canonicalRefresh.operationId,
        location,
      );
      if (write) writes.push(write);
      continue;
    }
    if (
      sameResourceLocation(record.canonical, location) ||
      !sameResourceLocation(observed.canonical, record.canonical)
    )
      continue;
    writes.push({
      expectedRevision: record.revision,
      next: { ...record, revision: record.revision + 1, canonical: location },
    });
  }
  return writes;
}
