/** Shared peer-edit labels for editor marks and durable trail rows. */
import { i18n } from "@/lib/i18n";

export function changeKindLabel(kind: "insert" | "modify" | "delete"): string {
  if (kind === "insert") return i18n._("Added a passage");
  if (kind === "modify") return i18n._("Replaced a passage");
  return i18n._("Deleted a passage");
}

export function collaboratorChangeLabel(): string {
  return i18n._("Collaborator edited text");
}

export function peerMarkAccessibleLabel(label: string): string {
  return i18n._("Show change details for {label}", { label });
}

export function changeMarkLabel(
  kind: "insert" | "modify" | "delete",
  pureDeletionOffset: number | null,
  agentName?: string,
): string {
  const verb =
    kind === "modify" && pureDeletionOffset !== null
      ? i18n._("Deleted a passage")
      : changeKindLabel(kind);
  return agentName ? `${agentName} · ${verb}` : verb;
}
