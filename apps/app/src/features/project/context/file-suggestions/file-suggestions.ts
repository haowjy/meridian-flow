/** Pure normalized-catalog projection and ranking for file suggestion hosts. */
import type { ProjectContextTreeScheme } from "@meridian/contracts/protocol";
import type { CatalogCacheView } from "@/client/query/context-catalog-cache";

export type FileSuggestionKind = "file" | "dir";

export type FileSuggestion = {
  entryId: string;
  scheme: ProjectContextTreeScheme;
  path: string;
  name: string;
  kind: FileSuggestionKind;
  parents: readonly string[];
};

export function catalogFileSuggestions(views: readonly CatalogCacheView[]): FileSuggestion[] {
  const suggestions: FileSuggestion[] = [];
  const seen = new Set<string>();
  for (const view of views) {
    const sources = new Map(
      [...view.entries.values()].flatMap((entry) =>
        entry.kind === "source" ? [[entry.entryId, entry] as const] : [],
      ),
    );
    for (const entry of view.entries.values()) {
      if (view.invalidatedEntryIds.has(entry.entryId)) continue;
      if (entry.kind === "source") {
        const key = `${entry.scheme}:${entry.entryId}`;
        if (!seen.has(key)) {
          seen.add(key);
          suggestions.push({
            entryId: entry.entryId,
            scheme: entry.scheme,
            path: "/",
            name: entry.name,
            kind: "dir",
            parents: [],
          });
        }
        continue;
      }
      if (entry.kind !== "folder" && entry.kind !== "file") continue;
      const source = sources.get(entry.sourceId);
      if (!source) continue;
      const key = `${source.scheme}:${entry.entryId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      suggestions.push({
        entryId: entry.entryId,
        scheme: source.scheme,
        path: `/${entry.path.join("/")}`,
        name: entry.name,
        kind: entry.kind === "folder" ? "dir" : "file",
        parents: entry.path.slice(0, -1),
      });
    }
  }
  return suggestions;
}

/**
 * Direct children of one folder, directories first — the browse view of a
 * navigable destination picker. `path` is the folder's own path (`/` for a
 * scheme root); scheme-root entries themselves (`path === "/"`) are never
 * children.
 */
export function folderChildren(
  entries: readonly FileSuggestion[],
  scheme: ProjectContextTreeScheme,
  path: string,
): FileSuggestion[] {
  const children = entries.filter(
    (entry) => entry.scheme === scheme && entry.path !== "/" && parentPath(entry.path) === path,
  );
  return [
    ...children.filter((c) => c.kind === "dir"),
    ...children.filter((c) => c.kind === "file"),
  ];
}

/** Parent folder path of an entry path: `/a/b` → `/a`, `/a` → `/`. */
export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index <= 0 ? "/" : path.slice(0, index);
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
  const filtered = entries.filter(
    (entry) => (!kinds || kinds.has(entry.kind)) && (!schemes || schemes.has(entry.scheme)),
  );

  // Empty query: every entry ranks 0, so the pipeline reduces to the depth
  // sort (stable ties keep tree order) — skip the rank/map/filter ritual.
  if (!normalizedQuery) return filtered.sort((a, b) => a.parents.length - b.parents.length);

  return filtered
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
