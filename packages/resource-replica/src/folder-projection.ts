/** Folder namespace overlays rebase a catalog and readable document locations as one view. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { CatalogEntry } from "@meridian/contracts/protocol";
import { sameCatalogScope } from "./catalog-scope";
import { projectFolderLocation } from "./folder-namespace";
import { owningLocationIntent } from "./resource-intent-policy";
import type { FolderNamespaceRecord, ResourceLocation } from "./resource-records";
import { workAuthorityOf } from "./resource-records";
import { resourceContextAuthority } from "./resource-work-authority";

function folderOverlays(projectId: string, records: readonly FolderNamespaceRecord[]) {
  return records
    .filter(
      (record) =>
        record.projectId === projectId &&
        owningLocationIntent(projectId, record.intents, Boolean(record.canonicalRefresh)),
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
      current.workId !== source.workId ||
      (current.workSlug ?? null) !== (source.workSlug ?? null) ||
      (current.path !== source.path && !current.path.startsWith(`${source.path}/`))
    )
      continue;
    const destination = projectFolderLocation(folder);
    const path = destination.path + current.path.slice(source.path.length);
    current = {
      scheme: destination.scheme,
      path,
      name: path.split("/").at(-1) ?? destination.name,
      ...workAuthorityOf(destination),
    };
  }
  return current;
}

/** Supply all destination sources/parents, including other Work catalogs for cross-Work moves. */
export function projectFolderCatalog(
  projectId: string,
  entries: readonly CatalogEntry[],
  folders: readonly FolderNamespaceRecord[],
): readonly CatalogEntry[] {
  if (folderOverlays(projectId, folders).length === 0) return entries;
  const moved = new Set<string>();
  const projected = entries.map((entry): CatalogEntry => {
    if (entry.kind !== "file" && entry.kind !== "folder") return entry;
    const parsed = parseContextUri(entry.uri);
    if (!parsed.ok) throw new Error("Invalid catalog namespace URI");
    const workId = entry.scope.kind === "work" ? entry.scope.workId : null;
    const location: ResourceLocation = {
      scheme: parsed.value.scheme,
      path: `/${entry.path.join("/")}`,
      name: entry.name,
      ...(workId === null
        ? { workId: null }
        : {
            workId,
            workSlug:
              parsed.value.authority.kind === "work" ? parsed.value.authority.workSlug : null,
          }),
    };
    const next = rebaseFolderResourceLocation(projectId, location, folders);
    if (next === location) return entry;
    const source = entries.find(
      (candidate) =>
        candidate.kind === "source" &&
        candidate.scheme === next.scheme &&
        (next.workId !== null
          ? candidate.scope.kind === "work" && candidate.scope.workId === next.workId
          : next.scheme === "user"
            ? candidate.scope.kind === "user"
            : candidate.scope.kind === "project" && candidate.scope.projectId === projectId),
    );
    if (source?.kind !== "source") throw new Error("Folder destination source is not installed");
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
  return projected.map((entry): CatalogEntry => {
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
}

function namespaceUri(location: ResourceLocation): string {
  const authority = resourceContextAuthority(location.scheme, location);
  const qualifier =
    authority.kind === "work" ? `@${authority.workSlug}/` : authority.kind === "none" ? "@/" : "";
  const parsed = parseContextUri(
    `${location.scheme}://${qualifier}${location.path.replace(/^\/+/, "")}`,
  );
  if (!parsed.ok) throw new Error("Invalid projected namespace URI");
  return parsed.value.normalized;
}
