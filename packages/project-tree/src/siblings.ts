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
  return compareRankThenId(left.rank ?? "", left.entryId, right.rank ?? "", right.entryId);
}

// Compare ranks bytewise, never with the name collator, then by id, so equal ranks from
// concurrent inserts converge everywhere
export function compareRankThenId(
  leftRank: string,
  leftId: string,
  rightRank: string,
  rightId: string,
): number {
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
