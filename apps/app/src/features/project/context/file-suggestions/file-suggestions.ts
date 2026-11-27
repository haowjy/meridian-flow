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

function folderNames(path: string): string[] {
  return path
    .split("/")
    .filter(Boolean)
    .slice(0, -1)
    .map((segment) => readSegment(segment).name);
}

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

export function matchFileSuggestions(
  entries: readonly FileSuggestion[],
  query: string,
): FileSuggestion[] {
  const trimmed = query.trim();
  const pathQuery = trimmed.toLocaleLowerCase();
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
