/** The shape of one import as this tab knows it. Immutable snapshots; the store replaces them. */
import type {
  ImportCounts,
  ImportEntryStatus,
  ImportFailureReason,
  ImportFolderStatus,
  ImportManifest,
  ImportStatus,
  ImportSummary,
} from "@meridian/contracts";
import type { ClientRow } from "./client-rows";
import type { ImportDestination } from "./destination";
import type { LocalPhase } from "./display-state";
import type { HeldFile } from "./manifest";

export type ImportRootMeta = { rootId: number; kind: "folder" | "file"; name: string };

/** What this tab holds for an import it started or resumed. */
export type LocalRun = {
  phase: LocalPhase;
  destination: ImportDestination;
  roots: readonly ImportRootMeta[];
  /** Predicted rows, drawn until the plan answers. */
  rows: readonly ClientRow[];
  /** Null once this tab no longer holds the files (stopped, finished or gone). */
  held: ReadonlyMap<number, HeldFile> | null;
  /** The manifest this tab sent, for matching a later selection. */
  manifest: ImportManifest | null;
  /** Files whose send failed here. The server still thinks they are planned. */
  failures: ReadonlyMap<number, ImportFailureReason>;
  /** Files being sent again after Retry. */
  retrying: ReadonlySet<number>;
};

export type ReportData = {
  summary: ImportSummary;
  roots: ImportStatus["roots"];
  /** The plan's folders, by id. */
  folders: ReadonlyMap<string, ImportFolderStatus>;
  entries: ReadonlyMap<number, ImportEntryStatus>;
  /**
   * The version through which every entry change has been read: a full read, then
   * each `since` cut. Null until the full report is read. The summary can be newer
   * (the open-imports list moves it); this never moves past changes not yet read.
   */
  cursor: string | null;
};

/** Whether every entry has been read, so `since` cuts are valid and the report can be drawn. */
export function fullyRead(report: ReportData | null | undefined): report is ReportData & {
  cursor: string;
} {
  return report?.cursor != null;
}

/**
 * Stop here as this tab asked for it, whether or not it holds the files: a
 * reloaded tab can stop an import too. `stopped` with no report means the import
 * ended here before the server heard of it.
 */
export type StopCommand = "none" | "stopping" | "failed" | "stopped";

export type ImportState = {
  importId: string;
  report: ReportData | null;
  local: LocalRun | null;
  stop: StopCommand;
  /** Local clock when the server's `lastActivityAt` last changed in front of this tab. */
  activitySeenAt: number | null;
};

/**
 * The server counts a file whose send failed here as still arriving. This tab
 * knows better: it failed. Reads (counts, rows) use these numbers.
 */
export function effectiveCounts(state: ImportState): ImportCounts | null {
  const summary = state.report?.summary;
  if (!summary) return null;
  const entries = state.report?.entries;
  const local = state.local;
  if (!entries?.size || !local || (!local.failures.size && !local.retrying.size))
    return summary.counts;
  let arriving = summary.counts.arriving;
  let failed = summary.counts.failed;
  for (const entryId of local.failures.keys()) {
    const entry = entries.get(entryId);
    if (entry && (entry.state === "planned" || entry.state === "landing")) {
      arriving -= 1;
      failed += 1;
    }
  }
  for (const entryId of local.retrying) {
    if (entries.get(entryId)?.state === "failed") {
      arriving += 1;
      failed -= 1;
    }
  }
  return { ...summary.counts, arriving, failed };
}

/** One entry as shown: the server's word, except for a send that failed here. */
export function effectiveEntry(state: ImportState, entry: ImportEntryStatus): ImportEntryStatus {
  const local = state.local;
  if (local?.retrying.has(entry.entryId)) {
    return entry.state === "failed" ? { ...entry, state: "planned", reason: null } : entry;
  }
  const reason = local?.failures.get(entry.entryId);
  if (reason && (entry.state === "planned" || entry.state === "landing"))
    return { ...entry, state: "failed", reason };
  return entry;
}
