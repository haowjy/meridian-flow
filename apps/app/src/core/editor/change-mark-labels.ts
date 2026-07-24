/** Shared peer-edit labels for editor marks and durable trail rows. */

export function changeKindLabel(kind: "insert" | "modify" | "delete"): string {
  if (kind === "insert") return "AI added text";
  if (kind === "modify") return "AI changed text";
  return "AI deleted text";
}

export function collaboratorChangeLabel(): string {
  return "Collaborator edited text";
}

export function changeMarkLabel(
  kind: "insert" | "modify" | "delete",
  pureDeletionOffset: number | null,
  agentName?: string,
): string {
  const verb =
    kind === "modify" && pureDeletionOffset !== null ? "AI deleted text" : changeKindLabel(kind);
  return agentName ? `${agentName} · ${verb}` : verb;
}
