/** Pure context-tree flattening and ranking for file suggestion hosts. */
import type {
  ProjectContextTreeDirectory,
  ProjectContextTreeScheme,
} from "@meridian/contracts/protocol";

export type FileSuggestionKind = "file" | "dir";

export type FileSuggestion = {
  scheme: ProjectContextTreeScheme;
  path: string;
  name: string;
  kind: FileSuggestionKind;
  parents: readonly string[];
};

export type FileSuggestionTree = {
  scheme: ProjectContextTreeScheme;
  tree: ProjectContextTreeDirectory;
};

export function flattenFileSuggestionTrees(trees: readonly FileSuggestionTree[]): FileSuggestion[] {
  const entries: FileSuggestion[] = [];
  for (const { scheme, tree } of trees) {
    const visit = (
      node: ProjectContextTreeDirectory["children"][number] | ProjectContextTreeDirectory,
      parents: readonly string[],
    ) => {
      entries.push({ scheme, path: node.path, name: node.name, kind: node.kind, parents });
      if (node.kind === "dir") {
        const childParents = node.path === "/" ? parents : [...parents, node.name];
        for (const child of node.children) visit(child, childParents);
      }
    };
    visit(tree, []);
  }
  return entries;
}

type MatchOptions = {
  kinds?: readonly FileSuggestionKind[];
  schemes?: readonly ProjectContextTreeScheme[];
};

/**
 * Rank matches by the part a writer is most likely recalling: the beginning
 * of a leaf name, then a word within it, then anywhere in its full path.
 */
export function matchFileSuggestions(
  entries: readonly FileSuggestion[],
  query: string,
  options: MatchOptions = {},
): FileSuggestion[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const kinds = options.kinds ? new Set(options.kinds) : null;
  const schemes = options.schemes ? new Set(options.schemes) : null;

  return entries
    .filter((entry) => (!kinds || kinds.has(entry.kind)) && (!schemes || schemes.has(entry.scheme)))
    .map((entry, order) => ({ entry, order, rank: matchRank(entry, normalizedQuery) }))
    .filter((match) => match.rank !== null)
    .sort(
      (a, b) =>
        (a.rank ?? 0) - (b.rank ?? 0) ||
        a.entry.parents.length - b.entry.parents.length ||
        a.order - b.order,
    )
    .map(({ entry }) => entry);
}

function matchRank(entry: FileSuggestion, query: string): number | null {
  if (!query) return 0;
  const name = entry.name.toLocaleLowerCase();
  if (name.startsWith(query)) return 0;
  if (nameBoundaryIndexes(name).some((index) => name.startsWith(query, index))) return 1;
  const fullPath = `${entry.scheme} ${entry.parents.join(" ")} ${entry.path}`.toLocaleLowerCase();
  return fullPath.includes(query) ? 2 : null;
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
