/**
 * The one display state every surface shows (status row, report header, pane
 * notice), derived from the server's summary and what this tab is doing.
 */
import type { ImportCounts, ImportSummary } from "@meridian/contracts";

export type ImportDisplayState =
  | "preparing"
  | "importing"
  | "importing-elsewhere"
  | "paused"
  | "needs-attention"
  | "didnt-start"
  | "stopping"
  | "couldnt-stop"
  | "finished";

/** What this tab is doing for the import. */
export type LocalPhase =
  | { kind: "preparing"; totalBytes: number; planning: boolean }
  | { kind: "uploading" }
  | { kind: "idle" }
  | { kind: "stopping" }
  | { kind: "stop-failed" }
  | { kind: "not-started"; code: string | null };

/** A server that has not answered nor been heard from for this long is paused. */
export const ACTIVITY_FRESH_MS = 60_000;

export function processed(counts: ImportCounts): number {
  return counts.landed + counts.failed + counts.deleted + counts.notImported;
}

export function deriveDisplayState(input: {
  summary: ImportSummary | null;
  counts: ImportCounts | null;
  local: LocalPhase | null;
  /** Whether the server has been heard from doing something for this import lately. */
  activityFresh: boolean;
}): ImportDisplayState {
  const { summary, counts, local } = input;
  if (local?.kind === "not-started") return "didnt-start";
  if (local?.kind === "stopping") return "stopping";
  if (local?.kind === "stop-failed") return "couldnt-stop";
  if (summary?.state === "finished") return "finished";
  if (local?.kind === "preparing" || !summary || !counts) return "preparing";
  if (counts.arriving > 0) {
    if (local?.kind === "uploading") return "importing";
    return input.activityFresh ? "importing-elsewhere" : "paused";
  }
  if (counts.failed > 0) return "needs-attention";
  // Every file is in; the server is about to finish.
  return "importing";
}

export const ACTIVE_STATES: readonly ImportDisplayState[] = [
  "preparing",
  "importing",
  "importing-elsewhere",
  "stopping",
];

export function isActive(state: ImportDisplayState): boolean {
  return ACTIVE_STATES.includes(state);
}
