import { parseContextUri } from "@meridian/contracts";
import { type ProjectContextTreeScheme, readSegment } from "@meridian/contracts/protocol";
import type { TreeNode, TreeProjection } from "@meridian/project-tree";
import { buildTreeView, type TreeView } from "@/core/project-tree/tree-view";

type Row = { documentId: string; uri: string };

/** A UUID from 32 hex digits, its last digits made unique by `n`. */
const uuidLike = (hex: string, n: number) => {
  const digits = `${hex.slice(0, 28)}${n.toString(16).padStart(4, "0")}`;
  return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`;
};

/**
 * The project trees behind link-index fixtures: one tree per scheme (contextual authority),
 * with a folder for each directory of a row's path, so the index's walk has something to walk.
 * A folder's id is UUID-like and begins with its `~` suffix, as a real twin's does.
 */
export function treesOfRows(rows: readonly Row[]): TreeView[] {
  const schemes = new Set<string>();
  for (const row of rows) {
    const parsed = parseContextUri(row.uri);
    if (parsed.ok) schemes.add(parsed.value.scheme);
  }
  return [...schemes].map((scheme) => {
    const source = `source-${scheme}`;
    const nodes = new Map<string, TreeNode>();
    const children = new Map<string, TreeNode[]>();
    const folderIds = new Map<string, string>();
    const add = (id: string, kind: "folder" | "document", segment: string, parent: string) => {
      const { name, suffix } = readSegment(segment);
      const node = {
        id,
        kind,
        name,
        ...(suffix ? { suffix } : {}),
        parent,
        source,
        filetype: "md",
        provisional: false,
        hasProperties: false,
        trashed: false,
        purged: false,
      } as TreeNode;
      nodes.set(id, node);
      children.set(parent, [...(children.get(parent) ?? []), node]);
    };
    for (const row of rows) {
      const parsed = parseContextUri(row.uri);
      if (!parsed.ok || parsed.value.scheme !== scheme) continue;
      const segments = parsed.value.path.split("/");
      const name = segments.pop() as string;
      let parent = `source:${source}`;
      for (const segment of segments) {
        const key = `${parent}/${segment}`;
        let id = folderIds.get(key);
        if (!id) {
          const hex = (readSegment(segment).suffix ?? "").padEnd(32, "0");
          id = uuidLike(hex, folderIds.size);
          folderIds.set(key, id);
          add(id, "folder", segment, parent);
        }
        parent = id;
      }
      add(row.documentId, "document", name, parent);
    }
    return buildTreeView({
      projection: { nodes, children } as unknown as TreeProjection,
      scheme: scheme as ProjectContextTreeScheme,
      source: { id: source },
      authority: { kind: "contextual" },
    });
  });
}

/** A link index fixture: rows and the trees they sit in. */
export function linkIndexOf<D extends Row, F extends { folderId: string; uri: string } = never>(
  documents: readonly D[],
  folders: readonly F[] = [],
) {
  return { documents, folders, trees: treesOfRows(documents) };
}
