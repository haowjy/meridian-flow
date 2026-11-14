/**
 * The model's tree: the names it has been shown (tree-tools.md, "The tree frontier"). A name is a
 * folder and a leaf; the map says which node the model was shown it to mean, or that nothing was
 * there. Paths the model writes are resolved through it against the tree as it is now, so a name
 * that was renamed, moved or deleted since still reaches the node the model meant, and a name that
 * since means a different node reaches nothing.
 */
import { canonicalLeaf } from "@meridian/contracts/protocol";
import {
  childrenOf,
  isSourceRoot,
  type TreeNode,
  type TreeProjection,
} from "@meridian/project-tree";

/** What one result added to the map: folders listed whole, and the names it showed. */
export type ShownDelta = {
  /** Folders whose whole listing the result showed: a name not in `names` there is absent. */
  whole: string[];
  /** `[folder, name, node]`: the node the name was shown to mean, or null for nothing there. */
  names: Array<[string, string, string | null]>;
};

export type NamesShown = {
  whole: Set<string>;
  names: Map<string, Map<string, string | null>>;
};

export const emptyShown = (): NamesShown => ({ whole: new Set(), names: new Map() });

/** Folds `delta` into `shown`: a restated listing replaces what the folder's names meant. */
export function addDelta(shown: NamesShown, delta: ShownDelta): void {
  for (const folder of delta.whole) {
    shown.whole.add(folder);
    shown.names.delete(folder);
  }
  for (const [folder, name, node] of delta.names) {
    const names = shown.names.get(folder) ?? new Map<string, string | null>();
    shown.names.set(folder, names);
    names.set(name, node);
  }
}

export const encodeDelta = (delta: ShownDelta): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(delta));

export const decodeDelta = (bytes: Uint8Array): ShownDelta =>
  JSON.parse(new TextDecoder().decode(bytes)) as ShownDelta;

/** `undefined`: never shown; `null`: shown to be empty; else the node. */
function shownAt(shown: NamesShown, folder: string, name: string): string | null | undefined {
  const names = shown.names.get(folder);
  if (names?.has(name)) return names.get(name);
  return shown.whole.has(folder) ? null : undefined;
}

/** The delta of a listing of `folder`: every shown name in it, and the folder as listed whole. */
export function listingDelta(projection: TreeProjection, folder: string): ShownDelta {
  return {
    whole: [folder],
    names: childrenOf(projection, folder).map((node) => [folder, node.displayName, node.id]),
  };
}

/** The path as a list of names from the area's top, and whether it named a folder (trailing `/`). */
export function splitSegments(path: string): { segments: string[]; folder: boolean } {
  const folder = path.endsWith("/");
  const segments = path.split("/").filter(Boolean);
  return { segments, folder };
}

/** The names a segment may mean in a folder: a document's leaf also goes through the name codec. */
function candidates(segment: string, last: boolean, folder: boolean): string[] {
  const canonical = last && !folder ? canonicalLeaf(segment) : segment;
  // What was written is a name before it is an alias: a folder named `ch1.md` is not `ch1`.
  return canonical === segment ? [segment] : [segment, canonical];
}

export type Resolution =
  | {
      kind: "node";
      node: TreeNode;
      /** Every name along the path with the node it meant, for the map. */
      along: Array<{ folder: string; name: string; node: string }>;
      /** The folder the node's own name sits in. */
      parent: string;
      /** Folders along the path that are in Trash (only with `through`). */
      trashed: TreeNode[];
    }
  | {
      /** The name now means a different node from the one the model was shown. */
      kind: "path_changed";
      folder: string;
      name: string;
      was: TreeNode;
      now: TreeNode;
    }
  | { kind: "gone"; node: TreeNode }
  | {
      /** No node: the first segment neither the map nor the tree holds. */
      kind: "missing";
      folder: string;
      /** How many segments were resolved before the missing one. */
      at: number;
      along: Array<{ folder: string; name: string; node: string }>;
      trashed: TreeNode[];
    }
  | { kind: "not_a_folder"; node: TreeNode; at: number };

/**
 * Resolves `path` from `root` (a source's top) one name at a time against the map and the tree
 * now (tree-tools.md, "Which tree a stale path is resolved against"). With `through`, a folder
 * the model was shown that is in Trash now is walked through and reported (a create or move into
 * a deleted folder is made, and the folder stands); the last segment is always refused as `gone`.
 */
export function resolveShown(
  projection: TreeProjection,
  shown: NamesShown,
  root: string,
  path: { segments: readonly string[]; folder: boolean },
  options: { through?: boolean } = {},
): Resolution {
  const along: Array<{ folder: string; name: string; node: string }> = [];
  const trashed: TreeNode[] = [];
  let folder = root;
  let node: TreeNode | undefined;
  for (const [at, segment] of path.segments.entries()) {
    const last = at === path.segments.length - 1;
    node = undefined;
    let name = segment;
    for (name of candidates(segment, last, path.folder)) {
      const now = childrenOf(projection, folder).find((child) => child.displayName === name);
      const was = shownAt(shown, folder, name);
      // A node the map names but this view lacks (shown in the other view) means what is there now.
      const meant = was ? projection.nodes.get(was) : undefined;
      if (meant && now && now.id !== meant.id)
        return { kind: "path_changed", folder, name, was: meant, now };
      if (meant?.purged) return { kind: "gone", node: meant };
      if (meant?.trashed) {
        if (!options.through || last) return { kind: "gone", node: meant };
        trashed.push(meant);
      }
      node = meant ?? now;
      if (node) break;
    }
    if (!node) return { kind: "missing", folder, at, along, trashed };
    along.push({ folder, name, node: node.id });
    if (!last) {
      if (node.kind !== "folder") return { kind: "not_a_folder", node, at };
      folder = node.id;
    }
  }
  if (!node) return { kind: "missing", folder: root, at: 0, along, trashed };
  return { kind: "node", node, along, parent: folder, trashed };
}

/** The delta of a resolved path: each name along it, and what the call itself changed. */
export function pathDelta(resolution: Extract<Resolution, { kind: "node" }>): ShownDelta {
  return { whole: [], names: resolution.along.map((e) => [e.folder, e.name, e.node]) };
}

/** The names a tree operation emptied and filled (nothing else is shown). */
export function changeDelta(
  emptied: ReadonlyArray<{ folder: string; name: string }>,
  filled: ReadonlyArray<{ folder: string; name: string; node: string }>,
): ShownDelta {
  return {
    whole: [],
    names: [
      ...emptied.map(({ folder, name }): [string, string, null] => [folder, name, null]),
      ...filled.map(({ folder, name, node }): [string, string, string] => [folder, name, node]),
    ],
  };
}

/** A node's path from its source's top, as the names a path is written in. */
export function pathNames(projection: TreeProjection, id: string): string[] {
  const names: string[] = [];
  for (
    let node = projection.nodes.get(id);
    node;
    node = isSourceRoot(node.parent) ? undefined : projection.nodes.get(node.parent)
  )
    names.unshift(node.displayName);
  return names;
}
