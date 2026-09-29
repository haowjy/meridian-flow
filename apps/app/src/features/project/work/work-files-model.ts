export type WorkFileGroups<Scratch, Upload> = {
  scratch: readonly Scratch[];
  uploads: readonly Upload[];
};

export type WorkFileSearch = (name: string) => boolean;

export function workFileSearch(search: string): WorkFileSearch {
  const query = search.trim().toLowerCase();
  return (name) => !query || name.toLowerCase().includes(query);
}

export function catalogSiblingNames(
  catalog: { children(parentId: string): readonly { name: string }[] } | null | undefined,
  file: { parentId: string },
): string[] {
  return catalog?.children(file.parentId).map((sibling) => sibling.name) ?? [];
}

export function filterWorkFileGroups<
  Scratch extends { name: string },
  Upload extends { name: string },
>(
  groups: WorkFileGroups<Scratch, Upload>,
  matches: WorkFileSearch,
): WorkFileGroups<Scratch, Upload> {
  const filter = <T extends { name: string }>(items: readonly T[]) =>
    items.filter((item) => matches(item.name));
  return {
    scratch: filter(groups.scratch),
    uploads: filter(groups.uploads),
  };
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
