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

// keep: Compare catalog ranks bytewise, never with the name collator, then by identity
export function compareCatalogSiblings(left: RankedSibling, right: RankedSibling): number {
  const leftRank = left.rank ?? "";
  const rightRank = right.rank ?? "";
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  return left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0;
}
