/** Memoized identity parent edges shared by folders, documents and deletion visibility. */
import { folderOwnsDeletion } from "./folder-namespace";
import { owningLocationIntent } from "./resource-intent-policy";
import type {
  FolderNamespaceRecord,
  ParentRef,
  ResourceDestination,
  ResourceLocation,
} from "./resource-records";
import { destinationLocation, ownerOf } from "./resource-records";

export type FolderPlacementNode = { id: string; canonical: ResourceLocation };
type Placement = { location: ResourceLocation; hidden: boolean };
export const qualifiedHome = (location: ResourceLocation) =>
  JSON.stringify([location.scheme, ownerOf(location), location.path.replace(/\/$/, "")]);

/** Canonical homes bind once. Pending commands supply edges, never path aliases. */
export function folderPlacementGraph(
  projectId: string,
  nodes: readonly FolderPlacementNode[],
  records: readonly FolderNamespaceRecord[],
  destinationInstalled: (location: ResourceLocation) => boolean = () => true,
) {
  const recordsById = new Map(
    records
      .filter((r) => r.projectId === null || r.projectId === projectId)
      .map((r) => [r.folderId, r]),
  );
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const homes = new Map([
    ...[...byId.values()].map((n) => [qualifiedHome(n.canonical), n.id] as const),
    ...[...recordsById.values()].map((r) => [qualifiedHome(r.canonical), r.folderId] as const),
  ]);
  function canonicalEdge(location: ResourceLocation): ResourceDestination {
    let path = location.path.slice(0, location.path.lastIndexOf("/"));
    while (path) {
      const id = homes.get(qualifiedHome({ ...location, path }));
      if (id)
        return {
          parent: { kind: "folder", folderId: id },
          name: location.path.slice(path.length + 1),
        };
      path = path.slice(0, path.lastIndexOf("/"));
    }
    return {
      parent: { kind: "root", scheme: location.scheme, owner: ownerOf(location) },
      name: location.path.replace(/^\//, ""),
    };
  }
  const canonicalParent = (location: ResourceLocation): ParentRef => canonicalEdge(location).parent;
  const canonical = new Map(
    [...byId.values()].map((n) => [
      n.id,
      canonicalEdge(recordsById.get(n.id)?.canonical ?? n.canonical),
    ]),
  );
  const edges = new Map<string, ResourceDestination>();
  for (const node of byId.values()) {
    const record = recordsById.get(node.id);
    const desired =
      record &&
      owningLocationIntent(record.projectId, record.intents, Boolean(record.canonicalRefresh))
        ?.desired;
    let edge =
      desired?.kind === "set-folder-location" ? desired.destination : canonical.get(node.id)!;
    if (edge.parent.kind === "folder") {
      if (!byId.has(edge.parent.folderId) || recordsById.get(edge.parent.folderId)?.terminal)
        edge = canonical.get(node.id)!;
    } else if (
      !destinationInstalled({
        ...edge.parent.owner,
        scheme: edge.parent.scheme,
        path: "",
        name: "",
      })
    )
      edge = canonical.get(node.id)!;
    edges.set(node.id, edge);
  }
  // Find cycles before resolving; all cycle members revert their edge together.
  const done = new Set<string>();
  for (const id of byId.keys()) {
    const chain: string[] = [];
    const active = new Map<string, number>();
    let next: string | undefined = id;
    while (next && !done.has(next)) {
      const start = active.get(next);
      if (start !== undefined) {
        for (const member of chain.slice(start)) edges.set(member, canonical.get(member)!);
        for (const member of chain.splice(start)) active.delete(member);
        continue;
      }
      active.set(next, chain.length);
      chain.push(next);
      const parent: ParentRef | undefined = edges.get(next)?.parent;
      next = parent?.kind === "folder" ? parent.folderId : undefined;
    }
    for (const member of chain) done.add(member);
  }
  const resolved = new Map<string, Placement>();
  function resolve(id: string): Placement {
    const cached = resolved.get(id);
    if (cached) return cached;
    const edge = edges.get(id)!;
    const parent = edge.parent.kind === "folder" ? resolve(edge.parent.folderId) : null;
    const location = destinationLocation(edge, (parentId) => resolve(parentId).location)!;
    const record = recordsById.get(id);
    const result = {
      location,
      hidden: Boolean(parent?.hidden || (record && folderOwnsDeletion(record))),
    };
    resolved.set(id, result);
    return result;
  }
  for (const id of byId.keys()) resolve(id);
  function place(location: ResourceLocation, destination?: ResourceDestination): Placement {
    const fallback = canonicalEdge(location);
    let edge = destination ?? fallback;
    if (
      edge.parent.kind === "folder" &&
      (!byId.has(edge.parent.folderId) || recordsById.get(edge.parent.folderId)?.terminal)
    )
      edge = fallback;
    const parent = edge.parent.kind === "folder" ? resolved.get(edge.parent.folderId) : null;
    const next = destinationLocation(edge, (id) => resolved.get(id)?.location ?? null) ?? location;
    return { location: next, hidden: Boolean(parent?.hidden) };
  }
  return {
    homes,
    canonicalParent,
    parentForFolder: (id: string) => edges.get(id)?.parent ?? null,
    locations: new Map([...resolved].map(([id, value]) => [id, value.location])),
    hidden: (id: string) => resolved.get(id)?.hidden ?? false,
    place,
  };
}
