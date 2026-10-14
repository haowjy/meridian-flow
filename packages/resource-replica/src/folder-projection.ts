/** Shared identity placement over all installed catalogs and namespace journals. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { CatalogEntry } from "@meridian/contracts/protocol";
import { catalogEntryParent } from "./catalog-installation";
import { projectFolderNeedsRepair } from "./folder-namespace";
import { folderPlacementGraph } from "./folder-placement";
import { owningLocationIntent, placementDestination } from "./resource-intent-policy";
import { projectResourceLocation } from "./resource-projection";
import type {
  FolderNamespaceRecord,
  ResourceLocation,
  ResourceProjectionSnapshot,
  ResourceRecord,
} from "./resource-records";
import { sameOwner } from "./resource-records";
import {
  catalogEntryOwner,
  ownerListedInScope,
  resourceContextAuthority,
  resourceUriQualifier,
} from "./resource-work-authority";

/** Supply all destination sources/parents, including other Work catalogs for cross-Work moves. */
export function createResourcePlacement(
  projectId: string,
  entries: readonly CatalogEntry[],
  folders: readonly FolderNamespaceRecord[],
) {
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
  const parents = new Map(
    entries.flatMap((entry) =>
      (entry.kind === "folder" || entry.kind === "file") && locations.has(entry.entryId)
        ? [[entry.entryId, catalogEntryParent(entry, locations.get(entry.entryId)!)] as const]
        : [],
    ),
  );
  const nodes = [
    ...new Map(
      entries
        .flatMap((entry) =>
          entry.kind === "folder" && locations.has(entry.entryId)
            ? [
                {
                  id: entry.entryId,
                  canonical: locations.get(entry.entryId)!,
                  parent: parents.get(entry.entryId),
                  ancestryOnly: false,
                },
              ]
            : [],
        )
        .map((node) => [node.id, node]),
    ).values(),
  ];
  const installedIds = new Set(nodes.map((node) => node.id));
  // Journals retain known identities even when their catalog membership disappears.
  for (const folder of folders)
    if (
      (folder.projectId === null || folder.projectId === projectId) &&
      !installedIds.has(folder.folderId)
    )
      nodes.push({
        id: folder.folderId,
        canonical: folder.canonical,
        parent: folder.canonicalParent,
        ancestryOnly: folder.intents.length === 0,
      });
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
  const resourceLocations = new WeakMap<
    ResourceRecord,
    ReturnType<typeof projectResourceLocation>
  >();
  function resourceLocation(record: ResourceRecord) {
    if (resourceLocations.has(record)) return resourceLocations.get(record) ?? null;
    const own = projectResourceLocation(projectId, record, (id) => graph.locations.get(id) ?? null);
    if (!own) {
      resourceLocations.set(record, null);
      return null;
    }
    const placed = graph.place(
      (record.resource.canonicalParent
        ? record.resource.canonical
        : locations.get(record.resource.identity.documentId)) ??
        record.resource.canonical ??
        own,
      placementDestination(projectId, record),
      record.resource.canonicalParent ?? parents.get(record.resource.identity.documentId),
    );
    const result = placed.hidden ? null : { ...placed.location, provisional: own.provisional };
    resourceLocations.set(record, result);
    return result;
  }
  function projectCatalog(
    input: readonly CatalogEntry[],
    records: readonly ResourceRecord[] = [],
  ): readonly CatalogEntry[] {
    const byDocument = new Map(
      records.map((record) => [record.resource.identity.documentId, record]),
    );
    const rows = [
      ...new Map([...entries, ...input].map((entry) => [entry.entryId, entry])).values(),
    ];
    let projected = rows.map((entry): CatalogEntry => {
      if (entry.kind !== "file" && entry.kind !== "folder") return entry;
      const location = locations.get(entry.entryId);
      const record = byDocument.get(entry.entryId);
      const next =
        entry.kind === "folder"
          ? (graph.locations.get(entry.entryId) ?? location)
          : record
            ? resourceLocation(record)
            : location && graph.place(location, undefined, parents.get(entry.entryId)).location;
      if (!next) return entry;
      const source = rows.find(
        (candidate) =>
          candidate.kind === "source" &&
          candidate.scheme === next.scheme &&
          ownerListedInScope(next, next.scheme, candidate.scope, projectId),
      );
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
    // Recovery belongs to the journal identity, not to current catalog membership.
    // Retain a row (and a reachable ancestor chain) until the writer repairs it.
    for (const folder of [...folders].sort((a, b) => a.folderId.localeCompare(b.folderId))) {
      if (
        (folder.projectId !== null && folder.projectId !== projectId) ||
        !projectFolderNeedsRepair(folder) ||
        projected.some((row) => row.entryId === folder.folderId)
      )
        continue;
      const location = graph.locations.get(folder.folderId)!;
      let source = projected.find(
        (candidate) =>
          candidate.kind === "source" &&
          candidate.scheme === location.scheme &&
          ownerListedInScope(location, location.scheme, candidate.scope, projectId),
      );
      if (!source || source.kind !== "source") {
        const scope =
          location.scheme === "user"
            ? { kind: "user" as const, userId: "self" }
            : location.rootThreadId !== undefined
              ? { kind: "lineage" as const, projectId, rootThreadId: location.rootThreadId }
              : location.workId
                ? { kind: "work" as const, projectId, workId: location.workId }
                : { kind: "project" as const, projectId };
        source = {
          kind: "source",
          entryId: `repair-source:${location.scheme}:${JSON.stringify(scope)}`,
          scope,
          scheme: location.scheme,
          name: location.scheme,
          uri: namespaceUri({ ...location, path: "" })!,
        };
        projected.push(source);
      }
      projected.push({
        kind: "folder",
        observationVersion: folder.observationVersion ?? "0",
        entryId: folder.folderId,
        sourceId: source.entryId,
        parentId: source.entryId,
        scope: source.scope,
        name: location.name,
        path: location.path.split("/").filter(Boolean),
        uri: namespaceUri(location)!,
        hasChildren: false,
      });
    }
    // Suppression is a result of the identity walk, before navigation gap completion.
    // Hidden incomplete subtrees must not leave synthesized parents behind.
    projected = projected.filter((entry) => {
      if (entry.kind !== "file" && entry.kind !== "folder") return true;
      if (entry.kind === "folder") return !graph.hidden(entry.entryId);
      const record = byDocument.get(entry.entryId);
      const location = locations.get(entry.entryId);
      return record
        ? Boolean(resourceLocation(record))
        : !location || !graph.place(location, undefined, parents.get(entry.entryId)).hidden;
    });
    // One qualified-home index installs real rows before navigation-only gaps.
    const homeKey = (sourceId: string, path: string) => JSON.stringify([sourceId, path]);
    const homes = new Map(
      projected.flatMap((row) =>
        row.kind === "folder" ? [[homeKey(row.sourceId, row.path.join("/")), row] as const] : [],
      ),
    );
    for (const entry of [...projected]) {
      if (entry.kind !== "folder" && entry.kind !== "file") continue;
      const parentPath = entry.path.slice(0, -1).join("/");
      if (!parentPath || homes.has(homeKey(entry.sourceId, parentPath))) continue;
      let parentId = entry.sourceId;
      const parsed = parseContextUri(entry.uri);
      if (!parsed.ok) continue;
      for (let depth = 1; depth < entry.path.length; depth++) {
        const parts = entry.path.slice(0, depth);
        const key = homeKey(entry.sourceId, parts.join("/"));
        const existing = homes.get(key);
        if (existing) {
          parentId = existing.entryId;
          continue;
        }
        const row: Extract<CatalogEntry, { kind: "folder" }> = {
          kind: "folder",
          observationVersion: "0",
          entryId: `repair-parent:${entry.sourceId}:${parts.join("/")}`,
          sourceId: entry.sourceId,
          parentId,
          scope: entry.scope,
          name: parts.at(-1)!,
          path: parts,
          uri: namespaceUri({
            scheme: parsed.value.scheme,
            path: `/${parts.join("/")}`,
            name: parts.at(-1)!,
            ...catalogEntryOwner(entry.scope, parsed.value.authority),
          })!,
          hasChildren: true,
          navigationOnly: true,
        };
        homes.set(key, row);
        projected.push(row);
        parentId = row.entryId;
      }
    }
    const projectedIds = new Set(projected.map((entry) => entry.entryId));
    const foldersById = new Map(folders.map((folder) => [folder.folderId, folder]));
    return projected.map((entry): CatalogEntry => {
      if (entry.kind !== "file" && entry.kind !== "folder") return entry;
      const record = byDocument.get(entry.entryId);
      const folder = foldersById.get(entry.entryId);
      const desired = folder
        ? owningLocationIntent(folder.projectId, folder.intents, Boolean(folder.canonicalRefresh))
            ?.desired
        : undefined;
      const canonicalParent = record?.resource.canonicalParent ?? parents.get(entry.entryId);
      const destination = record
        ? placementDestination(projectId, record)
        : desired?.kind === "set-folder-location"
          ? desired.destination
          : undefined;
      const identityParent =
        entry.kind === "folder"
          ? graph.parentForFolder(entry.entryId)
          : destination?.parent.kind === "folder" && !projectedIds.has(destination.parent.folderId)
            ? canonicalParent
            : (destination?.parent ?? canonicalParent);
      // Identity edges own canonical ancestry. Homes only complete navigation gaps or creation suffixes.
      if (
        identityParent?.kind === "folder" &&
        projectedIds.has(identityParent.folderId) &&
        !destination?.createFolders?.length
      )
        return { ...entry, parentId: identityParent.folderId };
      const parent = homes.get(homeKey(entry.sourceId, entry.path.slice(0, -1).join("/")));
      return { ...entry, parentId: parent?.entryId ?? entry.sourceId };
    });
  }

  return {
    resourceLocation,
    resourcePlacementPending: (record: ResourceRecord) => {
      const own = projectResourceLocation(projectId, record);
      const effective = resourceLocation(record);
      return (
        Boolean(
          own &&
            effective &&
            (effective.path !== own.path ||
              effective.scheme !== own.scheme ||
              !sameOwner(effective, own)),
        ) ||
        record.intents.some(
          (intent) =>
            intent.projectId === projectId &&
            intent.desired.kind === "set-location" &&
            (intent.state === "pending" ||
              intent.state === "submitted" ||
              intent.state === "received"),
        )
      );
    },
    folderLocation: (id: string) => graph.locations.get(id) ?? null,
    parentForFolder: graph.parentForFolder,
    parentForResource: (record: ResourceRecord) => {
      const destination = placementDestination(projectId, record);
      return destination
        ? destination.parent
        : record.resource.canonical
          ? (record.resource.canonicalParent ??
            parents.get(record.resource.identity.documentId) ??
            null)
          : null;
    },
    projectCatalog,
  };
}

export type ResourcePlacement = ReturnType<typeof createResourcePlacement>;

/** Standalone catalog policy; multi-surface consumers retain and share the placement context. */
export function projectFolderCatalog(
  projectId: string,
  entries: readonly CatalogEntry[],
  folders: readonly FolderNamespaceRecord[],
) {
  return createResourcePlacement(projectId, entries, folders).projectCatalog(entries);
}

function namespaceUri(location: ResourceLocation): string | null {
  const qualifier = resourceUriQualifier(resourceContextAuthority(location.scheme, location));
  const parsed = parseContextUri(
    `${location.scheme}://${qualifier}${location.path.replace(/^\/+/, "")}`,
  );
  if (!parsed.ok) return null;
  return parsed.value.normalized;
}

const snapshotPlacements = new WeakMap<
  ResourceProjectionSnapshot,
  Map<string, ResourcePlacement>
>();

/** Every consumer of an immutable replica observation shares one complete graph. */
export function resourcePlacementForSnapshot(
  projectId: string,
  snapshot: ResourceProjectionSnapshot,
): ResourcePlacement {
  let placements = snapshotPlacements.get(snapshot);
  if (!placements) {
    placements = new Map();
    snapshotPlacements.set(snapshot, placements);
  }
  let placement = placements.get(projectId);
  if (!placement) {
    placement = createResourcePlacement(
      projectId,
      snapshot.catalogs.filter((c) => c.projectId === projectId).flatMap((c) => c.entries),
      snapshot.folders,
    );
    placements.set(projectId, placement);
  }
  return placement;
}
