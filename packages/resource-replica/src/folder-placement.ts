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
  const aliases = ordered.flatMap((node) => {
    const record = recordsById.get(node.id);
    return [
      ...(record ? [{ id: node.id, location: record.canonical }] : []),
      ...(record?.intents ?? []).flatMap((intent) =>
        intent.desired.kind === "set-folder-location"
          ? [{ id: node.id, location: namespaceDestinationLocation(intent.desired.destination) }]
          : [],
      ),
    ];
  });
  function anchor(location: ResourceLocation, exclude: string, exact: boolean): Edge | null {
    const canonical = ordered
      .filter(
        (node) =>
          node.id !== exclude &&
          contains(node.canonical, location) &&
          (exact ? node.canonical.path === location.path : node.canonical.path !== location.path),
      )
      .sort((a, b) => b.canonical.path.length - a.canonical.path.length)[0];
    if (canonical)
      return {
        parent: canonical.id,
        base: location,
        suffix: location.path.slice(canonical.canonical.path.length),
      };
    if (!exact) return null;
    const alias = aliases.find(
      (a) =>
        a.id !== exclude &&
        a.location.scheme === location.scheme &&
        sameOwner(a.location, location) &&
        a.location.path === location.path,
    );
    if (alias) return { parent: alias.id, base: location, suffix: "" };
    // A child path may name an ancestor's earlier optimistic rename. Translate it back
    // to installed identity before looking up the actual destination parent.
    // Each identity can translate at most once on a branch. Revisiting it describes
    // an alias cycle, not another ancestor. This bounds traversal by simple paths
    // through the finite identity graph, including path-growing rename cycles.
    const queue = [{ location, used: new Set<string>() }];
    const key = (at: ResourceLocation, used: Set<string>) =>
      JSON.stringify([at.scheme, ownerOf(at), at.path, [...used].sort()]);
    const seen = new Set<string>([key(location, new Set())]);
    for (let i = 0; i < queue.length; i++) {
      const current = queue[i];
      for (const a of aliases) {
        if (current.used.has(a.id) || !contains(a.location, current.location)) continue;
        const node = ordered.find((n) => n.id === a.id);
        if (!node) continue;
        const translated = {
          ...node.canonical,
          path: node.canonical.path + current.location.path.slice(a.location.path.length),
        };
        const used = new Set([...current.used, a.id]);
        const state = key(translated, used);
        if (seen.has(state)) continue;
        seen.add(state);
        const match = ordered.find(
          (n) =>
            n.id !== exclude &&
            n.canonical.scheme === translated.scheme &&
            sameOwner(n.canonical, translated) &&
            n.canonical.path === translated.path,
        );
        if (match) return { parent: match.id, base: location, suffix: "" };
        queue.push({ location: translated, used });
      }
    }
    return null;
  }
  const canonical = new Map<string, Edge>();
  const edges = new Map<string, Edge>();
  for (const node of ordered) {
    const fallback = anchor(node.canonical, node.id, false) ?? {
      parent: null,
      base: node.canonical,
      suffix: node.canonical.path,
    };
    canonical.set(node.id, fallback);
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
  // Cycles have no topological ordering. Retire every cyclic placement together,
  // rather than letting traversal order choose which writer command wins.
  for (;;) {
    const cyclic = new Set<string>();
    for (const node of ordered) {
      const path: string[] = [];
      let id: string | null = node.id;
      while (id !== null && edges.has(id)) {
        const at = path.indexOf(id);
        if (at >= 0) {
          for (const member of path.slice(at)) cyclic.add(member);
          break;
        }
        path.push(id);
        id = edges.get(id)?.parent ?? null;
      }
    }
    if (!cyclic.size) break;
    for (const id of cyclic) edges.set(id, canonical.get(id)!);
    // Restoring canonical parents can expose another cycle with still-active moves.
    // Each wave retires more placement edges; canonical edges strictly reduce path depth.
  }
  const resolved = new Map<string, ResourceLocation>();
  function resolve(id: string, visiting = new Set<string>()): ResourceLocation {
    const cached = resolved.get(id);
    if (cached) return cached;
    const node = ordered.find((n) => n.id === id)!;
    if (visiting.has(id)) return node.canonical;
    visiting.add(id);
    const edge = edges.get(id)!;
    const parent = edge.parent ? resolve(edge.parent, visiting) : null;
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
