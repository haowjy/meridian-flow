/**
 * One import as a passive cache: the merged status (full read plus `since` cuts
 * plus this tab's own upload answers) and what this tab is doing for it. It never
 * reads, polls or ends itself; the coordinator does, and surfaces subscribe.
 */
import type {
  ImportEntryStatus,
  ImportFolderStatus,
  ImportStatus,
  ImportStatusChanges,
  ImportSummary,
} from "@meridian/contracts";
import { ACTIVITY_FRESH_MS, deriveDisplayState, type ImportDisplayState } from "./display-state";
import {
  effectiveCounts,
  fullyRead,
  type ImportState,
  type LocalRun,
  type StatusData,
} from "./import-state";

export class ImportStore {
  private state: ImportState;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly projectId: string,
    importId: string,
  ) {
    this.state = { importId, status: null, local: null, stop: "none", activitySeenAt: null };
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = () => this.state;

  get importId() {
    return this.state.importId;
  }

  update(change: (state: ImportState) => ImportState) {
    const next = change(this.state);
    if (next === this.state) return;
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  setLocal(change: (local: LocalRun) => LocalRun) {
    this.update((state) => (state.local ? { ...state, local: change(state.local) } : state));
  }

  dispose() {
    this.listeners.clear();
  }

  /** Install a summary seen in the open-imports list (no entries). The cursor stays. */
  seedSummary(summary: ImportSummary) {
    this.update((state) => {
      const current = state.status?.summary;
      if (current && compareVersions(current.version, summary.version) >= 0) return state;
      return {
        ...state,
        ...noteActivity(state, summary),
        status: state.status
          ? { ...state.status, summary }
          : { summary, roots: [], folders: new Map(), entries: new Map(), cursor: null },
      };
    });
  }

  /** A full read, from the plan's answer or a first load. An older read changes nothing. */
  installStatus(status: ImportStatus) {
    this.update((state) => {
      const cursor = state.status?.cursor;
      if (cursor != null && compareVersions(cursor, status.version) > 0) return state;
      return {
        ...state,
        ...noteActivity(state, status),
        status: {
          summary: newerSummary(state.status?.summary, summaryOf(status)),
          roots: status.roots,
          folders: new Map(status.folders.map((folder) => [folder.id, folder])),
          entries: new Map(status.entries.map((entry) => [entry.entryId, entry])),
          cursor: status.version,
        },
      };
    });
  }

  /** Entries this tab's own uploads answered. */
  mergeEntries(entries: readonly ImportEntryStatus[]) {
    this.update((state) => {
      if (!state.status) return state;
      const merged = new Map(state.status.entries);
      for (const entry of entries) merged.set(entry.entryId, entry);
      return { ...state, status: { ...state.status, entries: merged } };
    });
  }

  /** A `since` cut on top of a full read. */
  applyChanges(changes: ImportStatusChanges) {
    this.update((state) => {
      const status = state.status;
      if (!fullyRead(status)) return state;
      // An answer to an older request: what it says is already known.
      if (compareVersions(changes.version, status.cursor) < 0) return state;
      // A poll that found nothing changes nothing, so nothing downstream re-renders.
      if (
        changes.entries.length === 0 &&
        changes.folders.length === 0 &&
        changes.roots.length === 0 &&
        changes.version === status.cursor &&
        changes.version === status.summary.version
      )
        return state;
      const entries = new Map(status.entries);
      for (const entry of changes.entries) entries.set(entry.entryId, entry);
      const folders = changes.folders.length
        ? mergeFolders(status.folders, changes.folders)
        : status.folders;
      const moved = new Map(changes.roots.map((root) => [root.rootId, root]));
      return {
        ...state,
        ...noteActivity(state, changes),
        status: {
          ...status,
          roots: moved.size
            ? status.roots.map((root) => moved.get(root.rootId) ?? root)
            : status.roots,
          summary: newerSummary(status.summary, summaryOf(changes)),
          folders,
          entries,
          cursor: changes.version,
        },
      };
    });
  }
}

function mergeFolders(
  current: ReadonlyMap<string, ImportFolderStatus>,
  changed: readonly ImportFolderStatus[],
) {
  const merged = new Map(current);
  for (const folder of changed) merged.set(folder.id, folder);
  return merged;
}

function summaryOf(status: ImportSummary): ImportSummary {
  const { importId, state, destination, counts, lastActivityAt, version } = status;
  return { importId, state, destination, counts, lastActivityAt, version };
}

/** Versions are decimal strings; compare by length then text. */
export function compareVersions(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function newerSummary(current: ImportSummary | undefined, incoming: ImportSummary): ImportSummary {
  return !current || compareVersions(incoming.version, current.version) >= 0 ? incoming : current;
}

function noteActivity(state: ImportState, summary: ImportSummary): Partial<ImportState> {
  const previous = state.status?.summary.lastActivityAt;
  if (previous === undefined || previous === summary.lastActivityAt) return {};
  return { activitySeenAt: Date.now() };
}

/** The display state of an import right now. */
export function displayOf(state: ImportState, now = Date.now()): ImportDisplayState {
  const summary = state.status?.summary ?? null;
  const reported = summary ? Date.parse(summary.lastActivityAt) : Number.NaN;
  const activityFresh =
    (Number.isFinite(reported) && now - reported < ACTIVITY_FRESH_MS) ||
    (state.activitySeenAt !== null && now - state.activitySeenAt < ACTIVITY_FRESH_MS);
  return deriveDisplayState({
    summary,
    counts: effectiveCounts(state),
    local: state.local?.phase ?? null,
    stop: state.stop,
    activityFresh,
  });
}

export type { StatusData };
