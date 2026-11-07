/** Identity parent edges shared by folders, documents and deletion visibility. */
import { folderOwnsDeletion } from "./folder-namespace";
import { owningLocationIntent } from "./resource-intent-policy";
import type {
  FolderNamespaceRecord,
  ParentRef,
  ResourceDestination,
  ResourceLocation,
} from "./resource-records";
import { destinationLocation, ownerOf } from "./resource-records";

export type FolderPlacementNode = {
  id: string;
  canonical: ResourceLocation;
  parent?: ParentRef;
  /** Retained ancestry alone does not prove a missing destination is installed. */
  ancestryOnly?: boolean;
};
type Placement = { location: ResourceLocation; hidden: boolean };

/** Unknown ancestry is an absolute observation, never evidence about another identity. */
function absoluteEdge(location: ResourceLocation): ResourceDestination {
  return {
    parent: { kind: "root", scheme: location.scheme, owner: ownerOf(location) },
    name: location.path.startsWith("/") ? location.path.slice(1) : location.path,
  };
}

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
  const canonicalLocations = new Map<string, ResourceLocation>();
  const canonical = new Map<string, ResourceDestination>();
  for (const node of byId.values()) {
    const record = recordsById.get(node.id);
    // Record observations carry server freshness and local CAS fences during installation. Local
    // command admission without a parent observation does not supersede the catalog.
    const location =
      record?.canonicalParent && record.canonical ? record.canonical : node.canonical;
    const parent = record?.canonicalParent ?? node.parent;
    canonicalLocations.set(node.id, location);
    canonical.set(
      node.id,
      parent?.kind === "folder" && byId.has(parent.folderId)
        ? { parent, name: location.name }
        : absoluteEdge(location),
    );
  }
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
      if (
        !byId.has(edge.parent.folderId) ||
        byId.get(edge.parent.folderId)?.ancestryOnly ||
        recordsById.get(edge.parent.folderId)?.terminal
      )
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
  const done = new Set<string>();
  for (const id of byId.keys()) {
    const chain: string[] = [];
    const active = new Map<string, number>();
    let next: string | undefined = id;
    while (next && !done.has(next)) {
      const start = active.get(next);
      if (start !== undefined) {
        const members = chain.slice(start);
        const canonicalCycle = members.every(
          (member) => edges.get(member) === canonical.get(member),
        );
        // Each cycle permanently removes a pending edge or roots canonical members, so the finite edge set must terminate.
        for (const member of members) {
          if (canonicalCycle) canonical.set(member, absoluteEdge(canonicalLocations.get(member)!));
          edges.set(member, canonical.get(member)!);
        }
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
  for (const id of byId.keys()) {
    const chain: string[] = [];
    let next: string | undefined = id;
    while (next && !resolved.has(next)) {
      chain.push(next);
      const parent: ParentRef = edges.get(next)!.parent;
      next = parent.kind === "folder" ? parent.folderId : undefined;
    }
    for (const member of chain.reverse()) {
      const edge = edges.get(member)!;
      const parent = edge.parent.kind === "folder" ? resolved.get(edge.parent.folderId) : null;
      const record = recordsById.get(member);
      resolved.set(member, {
        location:
          edge === canonical.get(member) && edge.parent.kind === "root"
            ? canonicalLocations.get(member)!
            : destinationLocation(edge, (parentId) => resolved.get(parentId)?.location ?? null)!,
        hidden: Boolean(parent?.hidden || (record && folderOwnsDeletion(record))),
      });
    }
  }
  function place(
    location: ResourceLocation,
    destination?: ResourceDestination,
    canonicalParent?: ParentRef,
  ): Placement {
    const fallback =
      canonicalParent?.kind === "folder" && byId.has(canonicalParent.folderId)
        ? { parent: canonicalParent, name: location.name }
        : absoluteEdge(location);
    let edge = destination ?? fallback;
    if (
      edge.parent.kind === "folder" &&
      (!byId.has(edge.parent.folderId) ||
        byId.get(edge.parent.folderId)?.ancestryOnly ||
        recordsById.get(edge.parent.folderId)?.terminal)
    )
      edge = fallback;
    const parent = edge.parent.kind === "folder" ? resolved.get(edge.parent.folderId) : null;
    return {
      location:
        edge === fallback && edge.parent.kind === "root"
          ? location
          : (destinationLocation(edge, (id) => resolved.get(id)?.location ?? null) ?? location),
      hidden: Boolean(parent?.hidden),
    };
  }
  return {
    parentForFolder: (id: string) => edges.get(id)?.parent ?? null,
    locations: new Map([...resolved].map(([id, value]) => [id, value.location])),
    hidden: (id: string) => resolved.get(id)?.hidden ?? false,
    place,
  };
}
