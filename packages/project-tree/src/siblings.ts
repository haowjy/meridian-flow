export interface DefaultSiblingOrderEntry {
  kind: "folder" | "file";
  name: string;
  identity: string;
}

const NAME_ORDER = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function compareDefaultSiblings(
  left: DefaultSiblingOrderEntry,
  right: DefaultSiblingOrderEntry,
): number {
  if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
  const byName = NAME_ORDER.compare(left.name, right.name);
  if (byName !== 0) return byName;
  return left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0;
}

export type RankedSibling = { rank?: string | null; entryId: string };

export function compareCatalogSiblings(left: RankedSibling, right: RankedSibling): number {
  return compareRankThenId(
    { rank: left.rank ?? "", id: left.entryId },
    { rank: right.rank ?? "", id: right.entryId },
  );
}

// Compare ranks bytewise, never with the name collator, then by id, so equal ranks from
// concurrent inserts converge everywhere
export function compareRankThenId(
  left: { rank: string; id: string },
  right: { rank: string; id: string },
): number {
  if (left.rank !== right.rank) return left.rank < right.rank ? -1 : 1;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
