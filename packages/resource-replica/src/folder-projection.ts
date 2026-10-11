/** Folder namespace overlays rebase a catalog and readable document locations as one view. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { CatalogEntry } from "@meridian/contracts/protocol";
import { sameCatalogScope } from "./catalog-scope";
import { folderOwnsDeletion, projectFolderLocation } from "./folder-namespace";
import { owningLocationIntent } from "./resource-intent-policy";
import type { FolderNamespaceRecord, ResourceLocation } from "./resource-records";
import { ownerOf, sameOwner } from "./resource-records";
import {
  catalogEntryOwner,
  ownerListedInScope,
  resourceContextAuthority,
  resourceUriQualifier,
} from "./resource-work-authority";

function folderOverlays(projectId: string, records: readonly FolderNamespaceRecord[]) {
  return records
    .filter(
      (record) =>
        (record.projectId === null || record.projectId === projectId) &&
        owningLocationIntent(record.projectId, record.intents, Boolean(record.canonicalRefresh)),
    )
    .sort(
      (left, right) =>
        right.canonical.path.split("/").length - left.canonical.path.split("/").length,
    );
}

/** Same location ownership as command admission; segment boundaries exclude sibling prefixes. */
export function rebaseFolderResourceLocation(
  projectId: string,
  location: ResourceLocation,
  folders: readonly FolderNamespaceRecord[],
): ResourceLocation {
  let current = location;
  for (const folder of folderOverlays(projectId, folders)) {
    const source = folder.canonical;
    if (
      current.scheme !== source.scheme ||
      !sameOwner(current, source) ||
      (current.path !== source.path && !current.path.startsWith(`${source.path}/`))
    )
      continue;
    const destination = projectFolderLocation(folder);
    const path = destination.path + current.path.slice(source.path.length);
    current = {
      scheme: destination.scheme,
      path,
      name: path.split("/").at(-1) ?? destination.name,
      ...ownerOf(destination),
    };
  }
  return current;
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
  const moved = new Set<string>();
  const projected =
    folderOverlays(projectId, folders).length === 0
      ? entries
      : entries.map((entry): CatalogEntry => {
          if (entry.kind !== "file" && entry.kind !== "folder") return entry;
          const parsed = parseContextUri(entry.uri);
          if (!parsed.ok) throw new Error("Invalid catalog namespace URI");
          const location: ResourceLocation = {
            scheme: parsed.value.scheme,
            path: `/${entry.path.join("/")}`,
            name: entry.name,
            ...catalogEntryOwner(entry.scope, parsed.value.authority),
          };
          const next = rebaseFolderResourceLocation(projectId, location, folders);
          if (next === location) return entry;
          const source = entries.find(
            (candidate) =>
              candidate.kind === "source" &&
              candidate.scheme === next.scheme &&
              ownerListedInScope(next, next.scheme, candidate.scope, projectId),
          );
          if (source?.kind !== "source")
            throw new Error("Folder destination source is not installed");
          moved.add(entry.entryId);
          return {
            ...entry,
            name: next.name,
            path: next.path.split("/").filter(Boolean),
            scope: source.scope,
            sourceId: source.entryId,
            uri: namespaceUri(next),
          };
        });
  const topology = projected.map((entry): CatalogEntry => {
    if (entry.kind !== "file" && entry.kind !== "folder") return entry;
    if (!moved.has(entry.entryId)) return entry;
    const parentPath = entry.path.slice(0, -1).join("/");
    const parent = parentPath
      ? projected.find(
          (candidate) =>
            candidate.kind === "folder" &&
            candidate.sourceId === entry.sourceId &&
            sameCatalogScope(candidate.scope, entry.scope) &&
            candidate.path.join("/") === parentPath,
        )
      : null;
    if (parentPath && !parent) throw new Error("Folder destination parent is not installed");
    const parentId = parent?.entryId ?? entry.sourceId;
    return entry.parentId === parentId ? entry : { ...entry, parentId };
  });
  // Deletion follows placement: a moved-in node belongs to the deleted destination's subtree.
  const byId = new Map(topology.map((entry) => [entry.entryId, entry]));
  return topology.filter((entry) => {
    let current = entry;
    const seen = new Set<string>();
    for (;;) {
      if (deleted.has(current.entryId)) return false;
      if (current.kind !== "file" && current.kind !== "folder") return true;
      if (seen.has(current.entryId)) throw new Error("Catalog parent cycle");
      seen.add(current.entryId);
      const parent = byId.get(current.parentId);
      if (!parent) return true;
      current = parent;
    }
  });
}

function namespaceUri(location: ResourceLocation): string {
  const qualifier = resourceUriQualifier(resourceContextAuthority(location.scheme, location));
  const parsed = parseContextUri(
    `${location.scheme}://${qualifier}${location.path.replace(/^\/+/, "")}`,
  );
  if (!parsed.ok) throw new Error("Invalid projected namespace URI");
  return parsed.value.normalized;
}
