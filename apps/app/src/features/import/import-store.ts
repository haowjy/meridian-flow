/**
 * One import as an external store: the merged report (full read plus `since`
 * cuts plus this tab's own upload answers) and what this tab is doing for it.
 * Surfaces subscribe; the polling runs only while something is watching.
 */
import type {
  ImportEntryReport,
  ImportReport,
  ImportReportChanges,
  ImportSummary,
} from "@meridian/contracts";
import { ImportRequestError } from "@/client/api/imports-api";
import { ACTIVITY_FRESH_MS, deriveDisplayState, type ImportDisplayState } from "./display-state";
import type { ImportApi } from "./import-api-port";
import { effectiveCounts, type ImportState, type LocalRun, type ReportData } from "./import-state";

const POLL_MS = 2000;
const NOTICE_POLL_MS = 5000;

export type Watch = "report" | "notice" | "row";

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

  /** Install a summary seen in the open-imports list (no entries). */
  seedSummary(summary: ImportSummary) {
    this.update((state) => {
      if (
        state.report?.complete &&
        compareVersions(state.report.summary.version, summary.version) >= 0
      ) {
        return state;
      }
      const seen = noteActivity(state, summary);
      return {
        ...state,
        ...seen,
        report: state.report
          ? { ...state.report, summary: newerSummary(state.report.summary, summary) }
          : { summary, roots: [], entries: new Map(), complete: false },
      };
    });
  }

  /** A full read, from the plan's answer or a first load. */
  installReport(report: ImportReport) {
    this.update((state) => ({
      ...state,
      ...noteActivity(state, report),
      load: "idle",
      refreshFailed: false,
      report: {
        summary: summaryOf(report),
        roots: report.roots,
        entries: new Map(report.entries.map((entry) => [entry.entryId, entry])),
        complete: true,
      },
    }));
  }

  /** Entries this tab's own uploads answered. */
  mergeEntries(entries: readonly ImportEntryReport[]) {
    this.update((state) => {
      if (!state.report) return state;
      const merged = new Map(state.report.entries);
      for (const entry of entries) merged.set(entry.entryId, entry);
      return { ...state, report: { ...state.report, entries: merged } };
    });
  }

  private mergeChanges(changes: ImportReportChanges) {
    this.update((state) => {
      if (!state.report) return state;
      const merged = new Map(state.report.entries);
      for (const entry of changes.entries) merged.set(entry.entryId, entry);
      return {
        ...state,
        ...noteActivity(state, changes),
        refreshFailed: false,
        report: { ...state.report, summary: summaryOf(changes), entries: merged },
      };
    });
  }

  private readonly wantsEntries = () =>
    [...this.watchers.values()].some((kind) => kind === "report" || kind === "notice");

  /** One read: the whole report the first time, then only what changed. */
  async refresh(): Promise<void> {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      const report = this.state.report;
      if (report?.complete) {
        this.mergeChanges(
          await this.api.changes(this.projectId, this.importId, report.summary.version),
        );
      } else if (this.wantsEntries() || this.state.local) {
        this.update((state) => ({ ...state, load: state.report ? state.load : "loading" }));
        this.installReport(await this.api.report(this.projectId, this.importId));
      }
    } catch (error) {
      if (
        error instanceof ImportRequestError &&
        error.status === 404 &&
        !this.state.report?.complete
      ) {
        this.update((state) => ({ ...state, load: "missing" }));
      } else if (this.state.report?.complete) {
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
      const finished = this.state.report?.summary.state === "finished";
      if (!(finished && this.state.report?.complete)) await this.refresh();
      const stillWatched = this.watchers.size > 0;
      const done = this.state.report?.summary.state === "finished" && this.state.report.complete;
      if (stillWatched && !done) {
        this.schedule([...this.watchers.values()].includes("report") ? POLL_MS : NOTICE_POLL_MS);
      }
    }, delay);
  }

  private stopTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Retry the first load or a failed refresh now. */
  retryLoad() {
    this.update((state) => ({ ...state, load: state.report?.complete ? state.load : "idle" }));
    void this.refresh();
    this.schedule(POLL_MS);
  }
}

function summaryOf(report: ImportSummary): ImportSummary {
  const { importId, state, destination, sort, counts, lastActivityAt, version, dismissedAt } =
    report;
  return { importId, state, destination, sort, counts, lastActivityAt, version, dismissedAt };
}

/** Versions are decimal strings; compare by length then text. */
export function compareVersions(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function newerSummary(current: ImportSummary, incoming: ImportSummary): ImportSummary {
  return compareVersions(incoming.version, current.version) >= 0 ? incoming : current;
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
    activityFresh,
  });
}

export type { ReportData };
