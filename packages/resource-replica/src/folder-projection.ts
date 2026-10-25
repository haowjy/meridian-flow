/** Shared identity placement over all installed catalogs and namespace journals. */
import { parseContextUri } from "@meridian/contracts/context-uri";
import type { CatalogEntry, CatalogFileEntry, CatalogScope } from "@meridian/contracts/protocol";
import { catalogEntryParent } from "./catalog-installation";
import { projectFolderNeedsRepair } from "./folder-namespace";
import { folderPlacementGraph } from "./folder-placement";
import { projectOptimisticSiblingOrder } from "./optimistic-sibling-order";
import { owningLocationIntent, placementDestination } from "./resource-intent-policy";
import { projectResourceLocation } from "./resource-projection";
import type {
  FolderNamespaceRecord,
  ParentRef,
  ResourceLocation,
  ResourceProjectionSnapshot,
  ResourceRecord,
} from "./resource-records";
import { ownerOf, sameOwner } from "./resource-records";
import {
  catalogEntryOwner,
  ownerListedInScope,
  resourceContextAuthority,
  resourceContextUri,
} from "./resource-work-authority";
import { compareCatalogSiblings, isManualParent } from "./sibling-order";

type CatalogChild = Extract<CatalogEntry, { kind: "file" | "folder" }>;

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
  const sourceFor = (candidates: Iterable<CatalogEntry>, location: ResourceLocation) => {
    for (const candidate of candidates)
      if (
        candidate.kind === "source" &&
        candidate.scheme === location.scheme &&
        ownerListedInScope(location, location.scheme, candidate.scope, projectId)
      )
        return candidate;
    return undefined;
  };
  const scopeFor = (location: ResourceLocation): CatalogScope =>
    location.scheme === "user"
      ? { kind: "user", userId: "self" }
      : location.chatId !== undefined
        ? { kind: "chat", projectId, chatId: location.chatId }
        : location.rootThreadId !== undefined
          ? { kind: "lineage", projectId, rootThreadId: location.rootThreadId }
          : location.workId !== null
            ? { kind: "work", projectId, workId: location.workId }
            : { kind: "project", projectId };
  const graph = folderPlacementGraph(projectId, nodes, folders, (location) =>
    Boolean(sourceFor(entries, location)),
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
  /** The placed folder whose location is the directory of `location`, else the area root. */
  function parentAtLocation(location: ResourceLocation): ParentRef | null {
    const directory = location.path.slice(0, location.path.lastIndexOf("/"));
    if (!directory) return { kind: "root", scheme: location.scheme, owner: ownerOf(location) };
    for (const [folderId, folder] of graph.locations)
      if (
        folder.scheme === location.scheme &&
        folder.path === directory &&
        sameOwner(folder, location)
      )
        return { kind: "folder", folderId };
    return null;
  }
  function projectRows(
    rows: readonly CatalogEntry[],
    records: readonly ResourceRecord[],
    repairFolders: readonly FolderNamespaceRecord[],
    knownVisible: ReadonlySet<string>,
  ): readonly CatalogEntry[] {
    const byDocument = new Map(
      records.map((record) => [record.resource.identity.documentId, record]),
    );
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
    for (const folder of [...repairFolders].sort((a, b) => a.folderId.localeCompare(b.folderId))) {
      if (
        (folder.projectId !== null && folder.projectId !== projectId) ||
        !projectFolderNeedsRepair(folder) ||
        projected.some((row) => row.entryId === folder.folderId)
      )
        continue;
      const location = graph.locations.get(folder.folderId)!;
      let source = sourceFor(projected, location);
      if (source?.kind !== "source") {
        const scope = scopeFor(location);
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
        rank: folder.canonicalRank,
        orderPolicy: folder.canonicalOrderPolicy,
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
    const listedDocumentIds = new Set(
      rows.flatMap((entry) => (entry.kind === "file" ? [entry.entryId] : [])),
    );
    const projectedById = new Map(projected.map((entry) => [entry.entryId, entry]));
    for (const record of records) {
      const documentId = record.resource.identity.documentId;
      const location = resourceLocation(record);
      const visible =
        knownVisible.has(documentId) ||
        record.intents.some(
          (intent) => intent.projectId === projectId && intent.state !== "cancelled",
        ) ||
        location?.scheme === "user" ||
        listedDocumentIds.has(documentId);
      const installed = projectedById.get(documentId);
      const installedMatches =
        installed?.kind === "file" &&
        installed.uri.startsWith(`${location?.scheme}://`) &&
        `/${installed.path.join("/")}` === location?.path &&
        installed.provisionalName === location?.provisional;
      if (installed && !installedMatches) projectedById.delete(documentId);
      if (!visible || !location || installedMatches) continue;

      let source = sourceFor(projectedById.values(), location);
      if (source?.kind !== "source") {
        const scope = scopeFor(location);
        source = {
          kind: "source",
          entryId: `local-source:${location.scheme}:${JSON.stringify(scope)}`,
          scope,
          scheme: location.scheme,
          name: location.scheme,
          uri: requiredNamespaceUri({ ...location, path: "", name: "" }),
        };
        projectedById.set(source.entryId, source);
      }
      const path = location.path.split("/").filter(Boolean);
      projectedById.set(documentId, {
        kind: "file",
        observationVersion: record.resource.observationVersion ?? "0",
        entryId: documentId,
        scope: source.scope,
        sourceId: source.entryId,
        parentId: source.entryId,
        aliases: [],
        name: location.name,
        path,
        uri: requiredNamespaceUri(location),
        provisionalName: location.provisional,
        rank: record.resource.canonicalRank,
        ...record.resource.classification,
      } satisfies CatalogFileEntry);
    }
    projected = [...projectedById.values()];
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
    const foldersById = new Map(repairFolders.map((folder) => [folder.folderId, folder]));
    const placed = projected.map((entry): CatalogEntry => {
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
    return projectOptimisticSiblingOrder({
      projectId,
      canonical: rows,
      projected: placed,
      records,
      folders: repairFolders,
    });
  }

  function projectCatalog(
    input: readonly CatalogEntry[],
    records: readonly ResourceRecord[] = [],
  ): readonly CatalogEntry[] {
    const rows = [
      ...new Map([...entries, ...input].map((entry) => [entry.entryId, entry])).values(),
    ];
    return projectRows(rows, records, folders, new Set());
  }

  /** Project one record whose caller already proved project access. */
  function accessibleResourceCatalog(record: ResourceRecord): readonly CatalogEntry[] {
    return projectRows([], [record], [], new Set([record.resource.identity.documentId]));
  }

  const placedRows = new WeakMap<
    readonly ResourceRecord[],
    {
      byParent: Map<string, CatalogChild[]>;
      sources: Extract<CatalogEntry, { kind: "source" }>[];
    }
  >();
  /**
   * The files and folders a parent holds as placed, including pending moves and creates,
   * in the order the tree shows them.
   */
  function childrenAt(
    parent: ParentRef,
    records: readonly ResourceRecord[],
  ): readonly CatalogEntry[] {
    let index = placedRows.get(records);
    if (!index) {
      const byParent = new Map<string, CatalogChild[]>();
      const sources: Extract<CatalogEntry, { kind: "source" }>[] = [];
      const parents = new Map<string, CatalogEntry>();
      for (const row of projectCatalog(entries, records)) {
        parents.set(row.entryId, row);
        if (row.kind === "source") sources.push(row);
        if (row.kind !== "file" && row.kind !== "folder") continue;
        const siblings = byParent.get(row.parentId);
        if (siblings) siblings.push(row);
        else byParent.set(row.parentId, [row]);
      }
      for (const [parentId, siblings] of byParent) {
        const manual = isManualParent(parents.get(parentId));
        siblings.sort((left, right) => compareCatalogSiblings(manual, left, right));
      }
      index = { byParent, sources };
      placedRows.set(records, index);
    }
    const parentId =
      parent.kind === "folder"
        ? parent.folderId
        : index.sources.find(
            (candidate) =>
              candidate.scheme === parent.scheme &&
              ownerListedInScope(parent.owner, parent.scheme, candidate.scope, projectId),
          )?.entryId;
    return (parentId && index.byParent.get(parentId)) || [];
  }

  return {
    resourceLocation,
    childrenAt,
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
      if (destination) return destination.parent;
      const edge =
        record.resource.canonical &&
        (record.resource.canonicalParent ?? parents.get(record.resource.identity.documentId));
      if (edge) return edge;
      // An unconfirmed create has no edge yet, nor a just-confirmed one before its catalog
      // lists it: it sits in the folder that holds its shown location.
      const shown = resourceLocation(record);
      return shown ? parentAtLocation(shown) : null;
    },
    projectCatalog,
    accessibleResourceCatalog,
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
  const uri = resourceContextUri(
    location.scheme,
    location.path,
    resourceContextAuthority(location.scheme, location),
  );
  const parsed = uri ? parseContextUri(uri) : null;
  if (!parsed?.ok) return null;
  return parsed.value.normalized;
}

function requiredNamespaceUri(location: ResourceLocation): string {
  const uri = namespaceUri(location);
  if (!uri) throw new Error("Invalid local catalog URI");
  return uri;
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
