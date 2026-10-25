/** Shared default ordering for siblings whose parent has not been manually ordered. */

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
