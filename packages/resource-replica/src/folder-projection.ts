/** Folder namespace overlays rebase a catalog and readable document locations as one view. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { CatalogEntry } from "@meridian/contracts/protocol";
import { sameCatalogScope } from "./catalog-scope";
import { folderOwnsDeletion } from "./folder-namespace";
import { folderPlacementGraph } from "./folder-placement";
import type { FolderNamespaceRecord, ResourceLocation } from "./resource-records";
import { sameOwner } from "./resource-records";
import {
  catalogEntryOwner,
  ownerListedInScope,
  resourceContextAuthority,
  resourceUriQualifier,
} from "./resource-work-authority";

/** Documents use the same identity dependency graph as folder rows. */
export function rebaseFolderResourceLocation(
  projectId: string,
  location: ResourceLocation,
  folders: readonly FolderNamespaceRecord[],
): ResourceLocation {
  return folderPlacementGraph(
    projectId,
    folders.map((folder) => ({ id: folder.folderId, canonical: folder.canonical })),
    folders,
  ).rebase(location);
}

/** Pending deletes hide rows immediately; refusal releases the overlay. */
export function folderDeletionHidesLocation(
  projectId: string,
  location: ResourceLocation,
  folders: readonly FolderNamespaceRecord[],
): boolean {
  return folders.some(
    (folder) =>
      (folder.projectId === null || folder.projectId === projectId) &&
      folder.intents.some(
        (intent) =>
          intent.desired.kind === "delete" &&
          (intent.state === "pending" ||
            intent.state === "submitted" ||
            intent.state === "received"),
      ) &&
      location.scheme === folder.canonical.scheme &&
      sameOwner(location, folder.canonical) &&
      (location.path === folder.canonical.path ||
        location.path.startsWith(`${folder.canonical.path}/`)),
  );
}

/** Supply all destination sources/parents, including other Work catalogs for cross-Work moves. */
export function projectFolderCatalog(
  projectId: string,
  entries: readonly CatalogEntry[],
  folders: readonly FolderNamespaceRecord[],
): readonly CatalogEntry[] {
  const deleted = new Set(
    folders
      .filter(
        (folder) =>
          (folder.projectId === null || folder.projectId === projectId) &&
          folderOwnsDeletion(folder),
      )
      .map((folder) => folder.folderId),
  );
  const locations = new Map<string, ResourceLocation>();
  for (const entry of entries) {
    if (entry.kind !== "file" && entry.kind !== "folder") continue;
    const parsed = parseContextUri(entry.uri);
    if (!parsed.ok) continue;
    locations.set(entry.entryId, {
      scheme: parsed.value.scheme,
      path: `/${entry.path.join("/")}`,
      name: entry.name,
      ...catalogEntryOwner(entry.scope, parsed.value.authority),
    });
  }
  const nodes = entries.flatMap((entry) =>
    entry.kind === "folder" && locations.has(entry.entryId)
      ? [{ id: entry.entryId, canonical: locations.get(entry.entryId)! }]
      : [],
  );
  // Retained deletion records supply suppression identities even after their catalog rows disappear.
  for (const folder of folders)
    if (!nodes.some((node) => node.id === folder.folderId) && folderOwnsDeletion(folder))
      nodes.push({ id: folder.folderId, canonical: folder.canonical });
  const sourceFor = (location: ResourceLocation) =>
    entries.find(
      (candidate) =>
        candidate.kind === "source" &&
        candidate.scheme === location.scheme &&
        ownerListedInScope(location, location.scheme, candidate.scope, projectId),
    );
  const graph = folderPlacementGraph(projectId, nodes, folders, (location) =>
    Boolean(sourceFor(location)),
  );
  const projected = entries.map((entry): CatalogEntry => {
    if (entry.kind !== "file" && entry.kind !== "folder") return entry;
    const location = locations.get(entry.entryId);
    if (!location) return entry;
    const next =
      entry.kind === "folder"
        ? (graph.locations.get(entry.entryId) ?? location)
        : graph.rebase(location);
    const source = sourceFor(next);
    if (source?.kind !== "source") return entry;
    return {
      ...entry,
      name: next.name,
      path: next.path.split("/").filter(Boolean),
      scope: source.scope,
      sourceId: source.entryId,
      uri: namespaceUri(next) ?? entry.uri,
    };
  });
  const topology = projected.map((entry): CatalogEntry => {
    if (entry.kind !== "file" && entry.kind !== "folder") return entry;
    const parentPath = entry.path.slice(0, -1).join("/");
    const parent = projected.find(
      (candidate) =>
        candidate.kind === "folder" &&
        candidate.sourceId === entry.sourceId &&
        sameCatalogScope(candidate.scope, entry.scope) &&
        candidate.path.join("/") === parentPath,
    );
    const missingDeleted = nodes.find(
      (node) =>
        deleted.has(node.id) &&
        graph.locations.get(node.id)?.scheme === locations.get(entry.entryId)?.scheme &&
        sameOwner(graph.locations.get(node.id)!, locations.get(entry.entryId)!) &&
        graph.locations.get(node.id)?.path.split("/").filter(Boolean).join("/") === parentPath,
    );
    const parentId =
      parent?.entryId ?? missingDeleted?.id ?? (parentPath ? entry.parentId : entry.sourceId);
    return { ...entry, parentId };
  });
  // Deletion follows placement: a moved-in node belongs to the deleted destination's subtree.
  const byId = new Map(topology.map((entry) => [entry.entryId, entry]));
  return topology.filter((entry) => {
    let current = entry;
    const seen = new Set<string>();
    for (;;) {
      if (deleted.has(current.entryId)) return false;
      if (current.kind !== "file" && current.kind !== "folder") return true;
      if (seen.has(current.entryId)) return true;
      seen.add(current.entryId);
      if (deleted.has(current.parentId)) return false;
      const parent = byId.get(current.parentId);
      if (!parent) return true;
      current = parent;
    }
  });
}

function namespaceUri(location: ResourceLocation): string | null {
  const qualifier = resourceUriQualifier(resourceContextAuthority(location.scheme, location));
  const parsed = parseContextUri(
    `${location.scheme}://${qualifier}${location.path.replace(/^\/+/, "")}`,
  );
  if (!parsed.ok) return null;
  return parsed.value.normalized;
}
