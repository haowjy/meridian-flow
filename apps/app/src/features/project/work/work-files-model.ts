/** The Work Files tab's pure rules: name search, rename siblings, and tree order. */
import type { ContextEntrySibling } from "../context/context-entry-name";
export type WorkFileSearch = (name: string) => boolean;

export function workFileSearch(search: string): WorkFileSearch {
  const query = search.trim().toLowerCase();
  return (name) => !query || name.toLowerCase().includes(query);
}

export function catalogSiblings(
  catalog: { children(parentId: string): readonly ContextEntrySibling[] } | null | undefined,
  file: { parentId: string | null },
): readonly ContextEntrySibling[] {
  return file.parentId ? (catalog?.children(file.parentId) ?? []) : [];
}

/** A row's place in the file tree: its path, and whether it is a folder. */
export type TreePlace = { path: string; folder: boolean };

/**
 * The sidebar tree's order, flattened: level by level, folders before files,
 * then by name, with a folder's open contents right under it. A file still
 * being added sorts by the path it will land at, so it never jumps on landing.
 */
export function compareTreePlaces(left: TreePlace, right: TreePlace): number {
  const a = left.path.split("/").filter(Boolean);
  const b = right.path.split("/").filter(Boolean);
  for (let level = 0; level < Math.min(a.length, b.length); level += 1) {
    const [nameA, nameB] = [a[level] ?? "", b[level] ?? ""];
    if (nameA === nameB) continue;
    const folderA = level < a.length - 1 || left.folder;
    const folderB = level < b.length - 1 || right.folder;
    if (folderA !== folderB) return folderA ? -1 : 1;
    return nameA.localeCompare(nameB);
  }
  return a.length - b.length;
}

/**
 * A chat's notes folder, not a writer-made folder that happens to read like one.
 * The server publishes the owning chat with an associated thread root; a
 * writer's folder carries none, whatever its title reads like.
 */
export function isThreadFolder(folder: { threadId?: string }): boolean {
  return Boolean(folder.threadId);
}
