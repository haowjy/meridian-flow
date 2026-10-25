/** What a drag carries, decided from its types alone (the data is hidden until the drop). */

/** Reserved for drag-anywhere, which owns the payload behind this type. */
export const MERIDIAN_ENTRIES_MIME = "application/x-meridian-entries";

type DragPayloadKind = "entries" | "files" | "none";

/** Entries first: an internal drag wins even if it ever carries Files too. */
export function dragPayloadKind(types: readonly string[]): DragPayloadKind {
  if (types.includes(MERIDIAN_ENTRIES_MIME)) return "entries";
  if (types.includes("Files")) return "files";
  return "none";
}
