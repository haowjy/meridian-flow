/**
 * One import as an external store: the merged report (full read plus `since`
 * cuts plus this tab's own upload answers) and what this tab is doing for it.
 * Surfaces subscribe; the polling runs only while something is watching.
 */
import type {
  ImportEntryStatus,
  ImportStatus,
  ImportStatusChanges,
  ImportSummary,
} from "@meridian/contracts";
import { ImportRequestError } from "@/client/api/imports-api";
import { ACTIVITY_FRESH_MS, deriveDisplayState, type ImportDisplayState } from "./display-state";
import type { ImportApi } from "./import-api-port";
import {
  effectiveCounts,
  fullyRead,
  type ImportState,
  type LocalRun,
  type ReportData,
} from "./import-state";

const POLL_MS = 2000;
const NOTICE_POLL_MS = 5000;

/** `report`: an open popover reading the numbers; `notice`: an indicator or pane notice keeping up. */
export type Watch = "report" | "notice";

export class ImportStore {
  private state: ImportState;
  private readonly listeners = new Set<() => void>();
  private readonly watchers = new Map<symbol, Watch>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private polling = false;
  private disposed = false;

  constructor(
    readonly projectId: string,
    importId: string,
    private readonly api: ImportApi,
  ) {
    this.state = {
      importId,
      report: null,
      local: null,
      stop: "none",
      load: "idle",
      refreshFailed: false,
      dismissing: false,
      dismissFailed: false,
      activitySeenAt: null,
    };
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

  /** Watch the import; the returned function stops watching. */
  watch(kind: Watch): () => void {
    const token = Symbol(kind);
    this.watchers.set(token, kind);
    this.schedule(0);
    return () => {
      this.watchers.delete(token);
      if (this.watchers.size === 0) this.stopTimer();
    };
  }

  dispose() {
    this.disposed = true;
    this.stopTimer();
  }

  /** Install a summary seen in the open-imports list (no entries). The cursor stays. */
  seedSummary(summary: ImportSummary) {
    this.update((state) => {
      const current = state.report?.summary;
      if (current && compareVersions(current.version, summary.version) >= 0) return state;
      return {
        ...state,
        ...noteActivity(state, summary),
        report: state.report
          ? { ...state.report, summary }
          : { summary, roots: [], entries: new Map(), cursor: null },
      };
    });
  }

  /** A full read, from the plan's answer or a first load. An older read changes nothing. */
  installReport(report: ImportStatus) {
    this.update((state) => {
      const cursor = state.report?.cursor;
      if (cursor != null && compareVersions(cursor, report.version) > 0)
        return { ...state, load: "idle", refreshFailed: false };
      return {
        ...state,
        ...noteActivity(state, report),
        load: "idle",
        refreshFailed: false,
        report: {
          summary: newerSummary(state.report?.summary, summaryOf(report)),
          roots: report.roots,
          entries: new Map(report.entries.map((entry) => [entry.entryId, entry])),
          cursor: report.version,
        },
      };
    });
  }

  /** Entries this tab's own uploads answered. */
  mergeEntries(entries: readonly ImportEntryStatus[]) {
    this.update((state) => {
      if (!state.report) return state;
      const merged = new Map(state.report.entries);
      for (const entry of entries) merged.set(entry.entryId, entry);
      return { ...state, report: { ...state.report, entries: merged } };
    });
  }

  private mergeChanges(changes: ImportStatusChanges) {
    this.update((state) => {
      const report = state.report;
      if (!fullyRead(report)) return state;
      // An answer to an older request: what it says is already known.
      if (compareVersions(changes.version, report.cursor) < 0) return state;
      // A poll that found nothing changes nothing, so nothing downstream re-renders.
      if (
        changes.entries.length === 0 &&
        changes.roots.length === 0 &&
        changes.version === report.cursor &&
        changes.version === report.summary.version &&
        !state.refreshFailed
      )
        return state;
      const merged = new Map(report.entries);
      for (const entry of changes.entries) merged.set(entry.entryId, entry);
      const moved = new Map(changes.roots.map((root) => [root.rootId, root]));
      return {
        ...state,
        ...noteActivity(state, changes),
        refreshFailed: false,
        report: {
          ...report,
          roots: moved.size
            ? report.roots.map((root) => moved.get(root.rootId) ?? root)
            : report.roots,
          summary: newerSummary(report.summary, summaryOf(changes)),
          entries: merged,
          cursor: changes.version,
        },
      };
    });
  }

  /** One read: the whole report the first time or when forced, else only what changed. */
  async refresh(forceFull = false): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      const report = this.state.report;
      // Until the plan has answered there is nothing on the server to read.
      const phase = this.state.local?.phase.kind;
      if (!report && (phase === "preparing" || phase === "not-started")) return;
      if (!report && this.state.stop === "stopped") return;
      // A forced read is whole: roots and lapsed claims change without moving the version.
      if (fullyRead(report) && !forceFull) {
        this.mergeChanges(await this.api.changes(this.projectId, this.importId, report.cursor));
      } else if (forceFull || this.watchers.size > 0 || this.state.local) {
        this.update((state) => ({ ...state, load: state.report ? state.load : "loading" }));
        this.installReport(await this.api.status(this.projectId, this.importId));
      }
    } catch (error) {
      if (
        error instanceof ImportRequestError &&
        error.status === 404 &&
        !fullyRead(this.state.report)
      ) {
        this.update((state) => ({ ...state, load: "missing" }));
      } else if (fullyRead(this.state.report)) {
        this.update((state) => ({ ...state, refreshFailed: true }));
      } else {
        this.update((state) => ({ ...state, load: "error" }));
      }
    } finally {
      this.polling = false;
    }
  }

  private schedule(delay: number) {
    if (this.disposed) return;
    this.stopTimer();
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      if (this.watchers.size === 0) return;
      if (!this.caughtUp()) await this.refresh();
      if (this.watchers.size > 0 && !this.caughtUp()) {
        // A big import is read less often: each read redraws a big tree.
        const big = (this.state.report?.entries.size ?? 0) > 500;
        const base = [...this.watchers.values()].includes("report") ? POLL_MS : NOTICE_POLL_MS;
        this.schedule(big ? base * 2 : base);
      }
    }, delay);
  }

  /** Finished, and every change up to the finishing version has been read. */
  private caughtUp(): boolean {
    const report = this.state.report;
    return (
      report?.summary.state === "finished" &&
      fullyRead(report) &&
      compareVersions(report.cursor, report.summary.version) >= 0
    );
  }

  private stopTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Retry the first load or a failed refresh now. */
  retryLoad() {
    this.update((state) => ({ ...state, load: fullyRead(state.report) ? state.load : "idle" }));
    void this.refresh();
    this.schedule(POLL_MS);
  }
}

function summaryOf(report: ImportSummary): ImportSummary {
  const { importId, state, destination, counts, lastActivityAt, version, dismissedAt } = report;
  return { importId, state, destination, counts, lastActivityAt, version, dismissedAt };
}

/** Versions are decimal strings; compare by length then text. */
export function compareVersions(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function newerSummary(current: ImportSummary | undefined, incoming: ImportSummary): ImportSummary {
  return !current || compareVersions(incoming.version, current.version) >= 0 ? incoming : current;
}

function noteActivity(state: ImportState, summary: ImportSummary): Partial<ImportState> {
  const previous = state.report?.summary.lastActivityAt;
  if (previous === undefined || previous === summary.lastActivityAt) return {};
  return { activitySeenAt: Date.now() };
}

export type ImportView = {
  state: ImportState;
  display: ImportDisplayState;
};

/** The display state of an import right now. */
export function displayOf(state: ImportState, now = Date.now()): ImportDisplayState {
  const summary = state.report?.summary ?? null;
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

export type { ReportData };
