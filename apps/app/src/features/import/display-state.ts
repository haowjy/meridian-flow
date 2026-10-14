/**
 * The one display state every surface shows (indicator, popover, pane
 * notice), derived from the server's summary and what this tab is doing.
 */
import type { ImportCounts, ImportRefusalCode, ImportSummary } from "@meridian/contracts";
import type { StopCommand } from "./import-state";

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
  | { kind: "preparing" }
  | { kind: "uploading" }
  | { kind: "idle" }
  | { kind: "not-started"; code: ImportRefusalCode | null };

/** A server that has not answered nor been heard from for this long is paused. */
export const ACTIVITY_FRESH_MS = 60_000;

export function processed(counts: ImportCounts): number {
  return counts.landed + counts.failed + counts.deleted + counts.notImported;
}

export function deriveDisplayState(input: {
  summary: ImportSummary | null;
  counts: ImportCounts | null;
  local: LocalPhase | null;
  stop: StopCommand;
  /** Whether the server has been heard from doing something for this import lately. */
  activityFresh: boolean;
}): ImportDisplayState {
  const { summary, counts, local, stop } = input;
  if (stop === "stopping") return "stopping";
  if (summary?.state === "finished") return "finished";
  // Stopped before the server heard of it: over, with nothing imported.
  if (stop === "stopped") return "finished";
  if (stop === "failed") return "couldnt-stop";
  if (local?.kind === "not-started") return "didnt-start";
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
