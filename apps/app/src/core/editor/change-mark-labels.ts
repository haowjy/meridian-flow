/** Shared peer-edit labels for editor marks and durable trail rows. */

export function changeKindLabel(kind: "insert" | "modify" | "delete"): string {
  if (kind === "insert") return "AI added text";
  if (kind === "modify") return "AI changed text";
  return "AI deleted text";
}

export function changeMarkLabel(
  kind: "insert" | "modify" | "delete",
  pureDeletionOffset: number | null,
): string {
  return kind === "modify" && pureDeletionOffset !== null
    ? "AI deleted text"
    : changeKindLabel(kind);
}
