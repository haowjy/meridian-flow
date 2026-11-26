import { normalEntryName } from "@meridian/contracts/context-entry-validation";
import {
  canonicalLeaf,
  childAtSegment,
  idHex,
  readSegment,
  withSegmentName,
} from "@meridian/contracts/protocol";
import {
  childrenOf,
  isSourceRoot,
  segmentOf,
  type TreeNode,
  type TreeProjection,
} from "@meridian/project-tree";

export type ShownDelta = {
  whole: string[];
  names: Array<[string, string, string | null]>;
};

export type NamesShown = {
  whole: Set<string>;
  names: Map<string, Map<string, string | null>>;
};

export const emptyShown = (): NamesShown => ({ whole: new Set(), names: new Map() });

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

function shownAt(shown: NamesShown, folder: string, name: string): string | null | undefined {
  const names = shown.names.get(folder);
  if (names?.has(name)) return names.get(name);
  return shown.whole.has(folder) ? null : undefined;
}

export function listingDelta(
  projection: TreeProjection,
  folder: string,
  visible: (node: TreeNode) => boolean = () => true,
): ShownDelta {
  const above = printedDelta(projection, [folder]);
  return {
    whole: [folder],
    names: [
      ...above.names,
      ...childrenOf(projection, folder)
        .filter(visible)
        .map((node): [string, string, string] => [folder, segmentOf(node), node.id]),
    ],
  };
}

export function splitSegments(path: string): { segments: string[]; folder: boolean } {
  const folder = path.endsWith("/");
  const segments = path.split("/").filter(Boolean);
  return { segments, folder };
}

export function candidates(segment: string, last: boolean, folder: boolean): string[] {
  const canonical = last && !folder ? canonicalLeaf(segment) : segment;
  return canonical === segment ? [segment] : [segment, canonical];
}

export type Resolution =
  | {
      kind: "node";
      node: TreeNode;
      along: Array<{ folder: string; name: string; node: string }>;
      parent: string;
      trashed: TreeNode[];
    }
  | { kind: "purged"; node: TreeNode }
  | { kind: "other_version"; folder: string; name: string }
  | {
      kind: "missing";
      folder: string;
      at: number;
      along: Array<{ folder: string; name: string; node: string }>;
      trashed: TreeNode[];
    }
  | { kind: "not_a_folder"; node: TreeNode; at: number };

/**
 * Resolves `path` from `root` (a source's top) one name at a time against the map and the tree
 * now (tree-tools.md, "Which tree a stale path is resolved against"). A name the model was shown
 * is followed to the node it meant, wherever that is now; a node in Trash is returned like any
 * other, and the folders of Trash along the way are listed in `trashed`. Where a segment names
 * nothing, it is tried joined to the next with `∕`, the look-alike a name's own `/` is stored as,
 * then to the one after, so a name typed `1/2/3` reaches the `1∕2∕3` it is stored as.
 */
export function resolveShown(
  projection: TreeProjection,
  shown: NamesShown,
  root: string,
  path: { segments: readonly string[]; folder: boolean },
): Resolution {
  const along: Array<{ folder: string; name: string; node: string }> = [];
  const trashed: TreeNode[] = [];
  const { segments } = path;
  let folder = root;
  let node: TreeNode | undefined;
  let at = 0;
  while (at < segments.length) {
    node = undefined;
    let width = 1;
    let name = segments[at] as string;
    const kids = childrenOf(projection, folder);
    for (; at + width <= segments.length && !node; width += 1) {
      const written =
        width === 1
          ? (segments[at] as string)
          : withSegmentName(segments.slice(at, at + width).join("/"), (joined) =>
              normalEntryName("folder", joined),
            );
      const last = at + width === segments.length;
      for (name of candidates(written, last, path.folder)) {
        const now =
          childAtSegment(kids, name, last ? undefined : "folder") ?? inTrashAt(kids, name);
        const was = shownAt(shown, folder, name);
        const meant = was ? projection.nodes.get(was) : undefined;
        if (was && !meant && now) return { kind: "other_version", folder, name };
        if (meant?.purged) return { kind: "purged", node: meant };
        if (meant?.trashed) trashed.push(meant);
        node = meant ?? now;
        if (node) break;
      }
    }
    if (!node) return { kind: "missing", folder, at, along, trashed };
    width -= 1;
    along.push({ folder, name, node: node.id });
    at += width;
    if (at < segments.length) {
      if (node.kind !== "folder") return { kind: "not_a_folder", node, at: at - 1 };
      folder = node.id;
    }
  }
  if (!node) return { kind: "missing", folder: root, at: 0, along, trashed };
  return { kind: "node", node, along, parent: folder, trashed };
}

export function printedDelta(projection: TreeProjection, ids: Iterable<string>): ShownDelta {
  const names: Array<[string, string, string | null]> = [];
  const seen = new Set<string>();
  for (const id of ids)
    for (
      let node = projection.nodes.get(id);
      node && !seen.has(node.id);
      node = isSourceRoot(node.parent) ? undefined : projection.nodes.get(node.parent)
    ) {
      seen.add(node.id);
      names.push([node.parent, segmentOf(node), node.id]);
    }
  return { whole: [], names };
}

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

export function pathNames(projection: TreeProjection, id: string): string[] {
  const names: string[] = [];
  for (
    let node = projection.nodes.get(id);
    node;
    node = isSourceRoot(node.parent) ? undefined : projection.nodes.get(node.parent)
  )
    names.unshift(segmentOf(node));
  return names;
}

function inTrashAt(kids: readonly TreeNode[], segment: string): TreeNode | undefined {
  const { suffix } = readSegment(segment);
  return kids
    .filter((child) =>
      !child.trashed
        ? false
        : suffix === undefined
          ? child.name === segment
          : idHex(child.id).startsWith(suffix),
    )
    .sort((a, b) => (a.id < b.id ? -1 : 1))[0];
}
