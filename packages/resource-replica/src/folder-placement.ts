/** Identity-bound folder placement graph. Missing dependencies fall back to canonical placement. */
import { namespaceDestinationLocation } from "./folder-namespace";
import { owningLocationIntent } from "./resource-intent-policy";
import type { FolderNamespaceRecord, ResourceLocation } from "./resource-records";
import { ownerOf, sameOwner } from "./resource-records";

export type FolderPlacementNode = { id: string; canonical: ResourceLocation };
type Edge = { parent: string | null; base: ResourceLocation; suffix: string };

const contains = (parent: ResourceLocation, child: ResourceLocation) =>
  parent.scheme === child.scheme &&
  sameOwner(parent, child) &&
  (parent.path === child.path || child.path.startsWith(`${parent.path}/`));

/** Resolve once by stable identity, never by the order records happen to be stored in. */
export function folderPlacementGraph(
  projectId: string,
  nodes: readonly FolderPlacementNode[],
  records: readonly FolderNamespaceRecord[],
  destinationInstalled: (location: ResourceLocation) => boolean = () => true,
) {
  const ordered = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const recordsById = new Map(
    records
      .filter((r) => r.projectId === null || r.projectId === projectId)
      .map((r) => [r.folderId, r]),
  );
  const key = (location: ResourceLocation) =>
    JSON.stringify([location.scheme, ownerOf(location), location.path]);
  const byId = new Map(ordered.map((node) => [node.id, node]));
  const installedHomes = new Map(ordered.map((node) => [key(node.canonical), node.id]));
  const historicalHomes = new Map<string, string>();
  for (const node of ordered) {
    const record = recordsById.get(node.id);
    const homes = [
      ...(record ? [record.canonical] : []),
      ...(record?.intents ?? []).flatMap((intent) =>
        intent.desired.kind === "set-folder-location"
          ? [namespaceDestinationLocation(intent.desired.destination)]
          : [],
      ),
    ];
    for (const home of homes)
      if (!historicalHomes.has(key(home))) historicalHomes.set(key(home), node.id);
  }
  function anchor(location: ResourceLocation, exclude: string, exact: boolean): Edge | null {
    const edge = (id: string, suffix: string): Edge | null =>
      id !== exclude ? { parent: id, base: location, suffix } : null;
    if (exact) {
      const direct = installedHomes.get(key(location)) ?? historicalHomes.get(key(location));
      if (direct && direct !== exclude) return edge(direct, "");
    }
    let path = location.path.slice(0, location.path.lastIndexOf("/"));
    while (path) {
      const home = { ...location, path };
      if (!exact) {
        const id = installedHomes.get(key(home));
        if (id && id !== exclude) return edge(id, location.path.slice(path.length));
      } else {
        // A historical ancestor home names its installed subtree. Bind the
        // descendant identity directly, not a sequence of historical rewrites.
        const ancestor = historicalHomes.get(key(home));
        if (ancestor) {
          const canonical = byId.get(ancestor)!.canonical;
          const descendant = installedHomes.get(
            key({
              ...canonical,
              path: canonical.path + location.path.slice(path.length),
            }),
          );
          if (descendant && descendant !== exclude) return edge(descendant, "");
        }
      }
      path = path.slice(0, path.lastIndexOf("/"));
    }
    return null;
  }
  const edges = new Map<string, Edge>();
  for (const node of ordered) {
    const fallback = anchor(node.canonical, node.id, false) ?? {
      parent: null,
      base: node.canonical,
      suffix: node.canonical.path,
    };
    const record = recordsById.get(node.id);
    const desired =
      record &&
      owningLocationIntent(record.projectId, record.intents, Boolean(record.canonicalRefresh))
        ?.desired;
    // Exact-ID availability can advance canonical state before catalog membership catches up.
    // It is the default placement, not a stale accepted intent reclaiming ownership.
    const target =
      desired?.kind === "set-folder-location"
        ? namespaceDestinationLocation(desired.destination)
        : (record?.canonical ?? node.canonical);
    if (
      target.scheme === node.canonical.scheme &&
      sameOwner(target, node.canonical) &&
      target.path === node.canonical.path
    ) {
      edges.set(node.id, fallback);
      continue;
    }
    const parentPath = target.path.slice(0, target.path.lastIndexOf("/"));
    const parent = { ...target, path: parentPath };
    const bound = parentPath ? anchor(parent, node.id, true) : null;
    const edge = bound
      ? { ...bound, suffix: `${bound.suffix}/${target.name}` }
      : { parent: null, base: target, suffix: target.path };
    edges.set(node.id, destinationInstalled(parent) && (!parentPath || bound) ? edge : fallback);
  }
  const resolved = new Map<string, ResourceLocation>();
  const resolving: string[] = [];
  const inProgress = new Map<string, number>();
  function resolve(id: string): ResourceLocation {
    const cached = resolved.get(id);
    if (cached) return cached;
    const node = byId.get(id)!;
    const cycleStart = inProgress.get(id);
    if (cycleStart !== undefined) {
      // Every cycle member falls back together; traversal order cannot pick a winner.
      for (let i = cycleStart; i < resolving.length; i++) {
        const member = resolving[i];
        resolved.set(member, byId.get(member)!.canonical);
      }
      return node.canonical;
    }
    inProgress.set(id, resolving.length);
    resolving.push(id);
    const edge = edges.get(id)!;
    const parent = edge.parent ? resolve(edge.parent) : null;
    resolving.pop();
    inProgress.delete(id);
    const fallback = resolved.get(id);
    if (fallback) return fallback;
    const path = parent ? parent.path + edge.suffix : edge.suffix;
    const location = {
      ...(parent ?? edge.base),
      path,
      name: path.split("/").at(-1) ?? node.canonical.name,
    };
    resolved.set(id, location);
    return location;
  }
  for (const node of ordered) resolve(node.id);
  return {
    locations: resolved,
    rebase(location: ResourceLocation): ResourceLocation {
      const node = ordered
        .filter((n) => contains(n.canonical, location))
        .sort((a, b) => b.canonical.path.length - a.canonical.path.length)[0];
      if (!node) return location;
      const destination = resolved.get(node.id)!;
      const path = destination.path + location.path.slice(node.canonical.path.length);
      if (
        path === location.path &&
        destination.scheme === location.scheme &&
        sameOwner(destination, location)
      )
        return location;
      return {
        scheme: destination.scheme,
        path,
        name: path.split("/").at(-1) ?? location.name,
        ...ownerOf(destination),
      };
    },
  };
}
