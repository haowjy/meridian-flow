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
