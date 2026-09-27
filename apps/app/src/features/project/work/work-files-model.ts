export type WorkFileGroups<Draft, Scratch = Draft, Upload = Draft> = {
  drafts: readonly Draft[];
  scratch: readonly Scratch[];
  uploads: readonly Upload[];
};

export function filterWorkFileGroups<
  Draft extends { name: string },
  Scratch extends { name: string },
  Upload extends { name: string },
>(
  groups: WorkFileGroups<Draft, Scratch, Upload>,
  search: string,
): WorkFileGroups<Draft, Scratch, Upload> {
  const query = search.trim().toLowerCase();
  const filter = <T extends { name: string }>(items: readonly T[]) =>
    query ? items.filter((item) => item.name.toLowerCase().includes(query)) : items;
  return {
    drafts: filter(groups.drafts),
    scratch: filter(groups.scratch),
    uploads: filter(groups.uploads),
  };
}
