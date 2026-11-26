/** Pure projection of the replay's trees, and ranking, for file suggestion hosts. */
import { normalEntryName } from "@meridian/contracts/context-entry-validation";
import { type ProjectContextTreeScheme, readSegment } from "@meridian/contracts/protocol";
import type { TreeEntry, TreeView } from "@/core/project-tree/tree-view";

export type FileSuggestionKind = "file" | "dir";

export type FileSuggestion = {
  entryId: string;
  scheme: ProjectContextTreeScheme;
  path: string;
  name: string;
  suffix?: string;
  kind: FileSuggestionKind;
  parents: readonly string[];
};

export function treeFileSuggestions(
  trees: readonly { scheme: ProjectContextTreeScheme; tree: TreeView }[],
): FileSuggestion[] {
  const suggestions: FileSuggestion[] = [];
  for (const { scheme, tree } of trees) {
    suggestions.push({
      entryId: tree.root.entryId,
      scheme,
      path: "/",
      name: tree.root.name,
      kind: "dir",
      parents: [],
    });
    const walk = (parentId: string) => {
      for (const entry of tree.children(parentId)) {
        suggestions.push(fileSuggestion(scheme, entry));
        if (entry.kind === "dir") walk(entry.entryId);
      }
    };
    walk(tree.root.entryId);
  }
  return suggestions;
}

export function fileSuggestion(scheme: ProjectContextTreeScheme, entry: TreeEntry): FileSuggestion {
  return {
    entryId: entry.kind === "dir" ? entry.entryId : entry.documentId,
    scheme,
    path: entry.path,
    name: entry.name,
    ...(entry.suffix ? { suffix: entry.suffix } : {}),
    kind: entry.kind,
    parents: folderNames(entry.path),
  };
}

/** The folders above a path as the writer reads them: a twin's `~id` is not part of a name. */
function folderNames(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .slice(0, -1)
    .map((segment) => readSegment(segment).name);
}

/**
 * Direct children of one folder in `entries`' order, which for
 * `treeFileSuggestions` is the writer's order in the tree. `path` is the
 * folder's own path (`/` for a scheme root); scheme-root entries themselves
 * (`path === "/"`) are never children.
 */
export function folderChildren(
  entries: readonly FileSuggestion[],
  scheme: ProjectContextTreeScheme,
  path: string,
): FileSuggestion[] {
  return entries.filter(
    (entry) => entry.scheme === scheme && entry.path !== "/" && parentPath(entry.path) === path,
  );
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
}

/**
 * Rank matches by the part a writer is most likely recalling: the beginning
 * of a leaf name, then a word within it, then anywhere in its full path.
 */
export function matchFileSuggestions(
  entries: readonly FileSuggestion[],
  query: string,
): FileSuggestion[] {
  const trimmed = query.trim();
  const pathQuery = trimmed.toLocaleLowerCase();
  // A name holds what the writer typed as it is stored (`1/2` as `1∕2`); a path keeps its `/`.
  const nameQuery = trimmed ? normalEntryName("folder", trimmed).toLocaleLowerCase() : "";
  return entries
    .map((entry, order) => ({ entry, order, rank: matchRank(entry, nameQuery, pathQuery) }))
    .filter((match) => match.rank !== null)
    .sort(
      (a, b) =>
        (a.rank ?? 0) - (b.rank ?? 0) ||
        a.entry.parents.length - b.entry.parents.length ||
        a.order - b.order,
    )
    .map(({ entry }) => entry);
}

function matchRank(entry: FileSuggestion, nameQuery: string, pathQuery: string): number | null {
  const name = entry.name.toLocaleLowerCase();
  const at = (index: number) =>
    name.startsWith(nameQuery, index) || name.startsWith(pathQuery, index);
  if (at(0)) return 0;
  if (nameBoundaryIndexes(name).some(at)) return 1;
  // Not the scheme: "man" would otherwise match every Manuscript file.
  return entry.path.toLocaleLowerCase().includes(pathQuery) ? 2 : null;
}

function nameBoundaryIndexes(name: string): number[] {
  const indexes: number[] = [];
  for (let index = 1; index < name.length; index += 1) {
    if (!/[\p{L}\p{N}]/u.test(name[index - 1] ?? "") && /[\p{L}\p{N}]/u.test(name[index] ?? "")) {
      indexes.push(index);
    }
  }
  return indexes;
}
