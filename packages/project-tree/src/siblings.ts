/** Sibling orders that listings outside the replay share with it. */

export interface DefaultSiblingOrderEntry {
  kind: "folder" | "file";
  name: string;
  identity: string;
}

const NAME_ORDER = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * Folders first, then numeric-aware displayed names, with identity as a stable tie-break.
 * Orders rows that arrive together (an import or copy) before they take ranks; a stored
 * parent is never ordered by it.
 */
export function compareDefaultSiblings(
  left: DefaultSiblingOrderEntry,
  right: DefaultSiblingOrderEntry,
): number {
  if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
  const byName = NAME_ORDER.compare(left.name, right.name);
  if (byName !== 0) return byName;
  return left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0;
}

/** What display order reads of a child: a server listing row has both. */
export type RankedSibling = { rank?: string | null; entryId: string };

/** Display order of one parent's children: rank (compared bytewise, never with the name collator), then identity. */
export function compareCatalogSiblings(left: RankedSibling, right: RankedSibling): number {
  const leftRank = left.rank ?? "";
  const rightRank = right.rank ?? "";
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
  return left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0;
}
