/** Shared sibling ordering: default name order, or stored ranks under a manually ordered parent. */
import type { CatalogEntry } from "@meridian/contracts/protocol";

export interface DefaultSiblingOrderEntry {
  kind: "folder" | "file";
  name: string;
  identity: string;
}

const NAME_ORDER = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Folders first, then numeric-aware displayed names, with identity as a stable tie-break. */
export function compareDefaultSiblings(
  left: DefaultSiblingOrderEntry,
  right: DefaultSiblingOrderEntry,
): number {
  if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
  const byName = NAME_ORDER.compare(left.name, right.name);
  if (byName !== 0) return byName;
  return left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0;
}

type CatalogChild = Extract<CatalogEntry, { kind: "folder" | "file" }>;

/**
 * Display order of one parent's children: rank (compared bytewise, never with the
 * name collator) under a manual parent, default order otherwise.
 */
export function compareCatalogSiblings(
  manual: boolean,
  left: CatalogChild,
  right: CatalogChild,
): number {
  if (manual) {
    const leftRank = left.rank ?? "";
    const rightRank = right.rank ?? "";
    if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;
    return left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0;
  }
  return compareDefaultSiblings(
    { kind: left.kind, name: left.name, identity: left.entryId },
    { kind: right.kind, name: right.name, identity: right.entryId },
  );
}

/** Whether `parent` orders its children by stored rank. */
export function isManualParent(parent: CatalogEntry | undefined): boolean {
  return (
    (parent?.kind === "source" || parent?.kind === "folder") && parent.orderPolicy === "manual"
  );
}
