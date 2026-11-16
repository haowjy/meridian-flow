import { parseContextUri } from "@meridian/contracts";
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { TreeNode, TreeProjection } from "@meridian/project-tree";
import { buildTreeView, type TreeView } from "@/core/project-tree/tree-view";

type Row = { documentId: string; uri: string };

/**
 * The project trees behind link-index fixtures: one tree per scheme (contextual authority),
 * with a folder for each directory of a row's path, so the index's walk has something to walk.
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
    const add = (id: string, kind: "folder" | "document", name: string, parent: string) => {
      const node = {
        id,
        kind,
        name,
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
        const id = `${parent}/${segment}`;
        if (!nodes.has(id)) add(id, "folder", segment, parent);
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
