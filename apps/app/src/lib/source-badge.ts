/** source-badge — shared provenance labels for app-owned definitions. */
import type { ProjectAgentSummary } from "@meridian/contracts/agents";

export function sourceBadgeLabel(
  source: ProjectAgentSummary["source"] | null,
  packageName: string | null,
): string | null {
  if (!source) return null;
  if (source === "builtin") return "Meridian";
  if (source === "package") return packageName ?? null;
  return packageName;
}
