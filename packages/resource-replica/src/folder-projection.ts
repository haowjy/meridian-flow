/** Shared identity placement over all installed catalogs and namespace journals. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { CatalogEntry } from "@meridian/contracts/protocol";
import { sameCatalogScope } from "./catalog-scope";
import { folderOwnsDeletion, projectFolderNeedsRepair } from "./folder-namespace";
import { folderPlacementGraph } from "./folder-placement";
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
  const nodes = [
    ...new Map(
      entries
        .flatMap((entry) =>
          entry.kind === "folder" && locations.has(entry.entryId)
            ? [{ id: entry.entryId, canonical: locations.get(entry.entryId)! }]
            : [],
        )
        .map((node) => [node.id, node]),
    ).values(),
  ];
  // Journals retain known identities even when their catalog membership disappears.
  for (const folder of folders)
    if (
      (folder.projectId === null || folder.projectId === projectId) &&
      !nodes.some((node) => node.id === folder.folderId)
    )
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
  function hiddenLocation(location: ResourceLocation) {
    return [...deleted].some((id) => {
      const folder = graph.locations.get(id)!;
      return (
        folder.scheme === location.scheme &&
        sameOwner(folder, location) &&
        (folder.path === location.path || location.path.startsWith(`${folder.path}/`))
      );
    });
  }
  function resourceLocation(record: ResourceRecord) {
    const own = projectResourceLocation(projectId, record);
    if (!own) return null;
    const next = graph.rebase(own);
    if (hiddenLocation(next)) return null;
    return next === own ? own : { ...next, provisional: own.provisional };
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
    const projected = rows.map((entry): CatalogEntry => {
      if (entry.kind !== "file" && entry.kind !== "folder") return entry;
      const location = locations.get(entry.entryId);
      const record = byDocument.get(entry.entryId);
      const next =
        entry.kind === "folder"
          ? (graph.locations.get(entry.entryId) ?? location)
          : record
            ? resourceLocation(record)
            : location && graph.rebase(location);
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
    // Install all real identities first. Only then fill unoccupied ancestor homes.
    // A missing parent must never steal a real recovery identity's children.
    for (const entry of [...projected]) {
      if (entry.kind !== "folder") continue;
      let parentId = entry.sourceId;
      for (let depth = 1; depth < entry.path.length; depth++) {
        const parts = entry.path.slice(0, depth);
        const existing = projected.find(
          (row) =>
            row.kind === "folder" &&
            row.sourceId === entry.sourceId &&
            sameCatalogScope(row.scope, entry.scope) &&
            row.path.join("/") === parts.join("/"),
        );
        if (existing) {
          parentId = existing.entryId;
          continue;
        }
        const entryId = `repair-parent:${entry.sourceId}:${parts.join("/")}`;
        const parsed = parseContextUri(entry.uri);
        if (!parsed.ok) continue;
        projected.push({
          kind: "folder",
          entryId,
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
        });
        parentId = entryId;
      }
    }
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
      const parentId = parent?.entryId ?? (parentPath ? entry.parentId : entry.sourceId);
      return { ...entry, parentId };
    });
    // Deletion follows placement: a moved-in node belongs to the deleted destination's subtree.
    const byId = new Map(topology.map((entry) => [entry.entryId, entry]));
    return topology.filter((entry) => {
      if (
        entry.kind === "file" &&
        byDocument.has(entry.entryId) &&
        !resourceLocation(byDocument.get(entry.entryId)!)
      )
        return false;
      if (entry.kind === "file" || entry.kind === "folder") {
        const parsed = parseContextUri(entry.uri);
        if (
          parsed.ok &&
          hiddenLocation({
            scheme: parsed.value.scheme,
            path: `/${entry.path.join("/")}`,
            name: entry.name,
            ...catalogEntryOwner(entry.scope, parsed.value.authority),
          })
        )
          return false;
      }
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
  return {
    resourceLocation,
    resourcePlacementPending: (record: ResourceRecord) => {
      const own = projectResourceLocation(projectId, record);
      return (
        Boolean(own && graph.rebase(own) !== own) ||
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
