/**
 * Runs imports for one project in this tab: prepare, plan, upload, retry, stop,
 * dismiss. Owns one store per import and the list of open imports. Navigate
 * first: `start` returns the import id at once and does the rest in the background.
 */
import { t } from "@lingui/core/macro";
import type { ImportFailureReason, ImportSummary } from "@meridian/contracts";
import { ImportRequestError } from "@/client/api/imports-api";
import { clientRowsFor } from "./client-rows";
import { matchHeld } from "./continue-check";
import type { ImportDestination } from "./destination";
import { type ImportApi, importApi } from "./import-api-port";
import type { ImportState } from "./import-state";
import { ImportStore } from "./import-store";
import { type BuiltManifest, buildManifest, bytesToHash, type HeldFile } from "./manifest";
import { announceMilestones } from "./milestones";
import type { Selection } from "./selection";
import { catalogPathOfUri } from "./tree-projection";
import { type UploadOutcome, UploadQueue } from "./uploader";

/** Imports over this many files redraw the tree no more often than every few seconds. */
const BIG_IMPORT = 500;
const BIG_IMPORT_TREE_MS = 3000;

export type ImportsSnapshot = { ids: readonly string[]; states: readonly ImportState[] };

export type RevealRequest = { scheme: string; path: string; nonce: number };

export type OpenImports = {
  summaries: readonly ImportSummary[];
  loaded: boolean;
  failed: boolean;
};

/**
 * What this tab is doing for one import: reading its files, the plan and the
 * sends. `retire` ends it for good; every step after an await checks `retired`
 * before it changes anything or calls the server.
 */
type Run = { readonly controller: AbortController; readonly queue: UploadQueue };

export class ImportCoordinator {
  private readonly stores = new Map<string, ImportStore>();
  private readonly runs = new Map<string, Run>();
  private readonly plans = new Map<string, Promise<unknown>>();
  private readonly startedAt = new Map<string, number>();
  private startedListeners = new Set<() => void>();
  private revealListeners = new Set<() => void>();
  private revealed: RevealRequest | null = null;
  private open: OpenImports = { summaries: [], loaded: false, failed: false };
  private readonly listeners = new Set<() => void>();
  private openTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(
    readonly projectId: string,
    private readonly api: ImportApi = importApi,
  ) {}

  // The imports this tab shows, for the tree's status rows and arriving rows.
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private snapshot: ImportsSnapshot = { ids: [], states: [] };
  readonly getSnapshot = () => this.snapshot;
  private lastTreeUpdate = 0;
  private treeTimer: ReturnType<typeof setTimeout> | undefined;
  /** `structural` changes (a row appearing or going) skip the big-import throttle. */
  private changed(structural = false) {
    // A big import re-renders a big tree; let it catch up at most every few seconds.
    const now = performance.now();
    const big = [...this.stores.values()].some((store) => {
      const state = store.getSnapshot();
      return (
        (state.report?.entries.size ?? 0) > BIG_IMPORT ||
        (state.local?.rows.length ?? 0) > BIG_IMPORT
      );
    });
    if (!structural && big && now - this.lastTreeUpdate < BIG_IMPORT_TREE_MS) {
      this.treeTimer ??= setTimeout(
        () => {
          this.treeTimer = undefined;
          this.changed();
        },
        BIG_IMPORT_TREE_MS - (now - this.lastTreeUpdate),
      );
      return;
    }
    if (this.treeTimer) clearTimeout(this.treeTimer);
    this.treeTimer = undefined;
    this.lastTreeUpdate = now;
    const ids = this.computeKnown();
    const states = ids
      .map((id) => this.stores.get(id)?.getSnapshot())
      .filter((s) => s !== undefined);
    const same =
      ids.length === this.snapshot.ids.length &&
      ids.every((id, index) => id === this.snapshot.ids[index]) &&
      states.every((state, index) => state === this.snapshot.states[index]);
    if (!same) this.snapshot = { ids, states };
    for (const listener of [...this.listeners]) listener();
  }

  /** Surfaces that must get out of the way when an import starts (the phone's drawer). */
  subscribeStarted(listener: () => void) {
    this.startedListeners.add(listener);
    return () => {
      this.startedListeners.delete(listener);
    };
  }
  notifyStarted() {
    for (const listener of [...this.startedListeners]) listener();
  }

  /** Ask the tree to open a folder and show it (the report's Open on a folder root). */
  reveal(request: { scheme: string; path: string }) {
    this.revealed = { ...request, nonce: (this.revealed?.nonce ?? 0) + 1 };
    for (const listener of [...this.revealListeners]) listener();
  }
  readonly subscribeReveal = (listener: () => void) => {
    this.revealListeners.add(listener);
    return () => this.revealListeners.delete(listener);
  };
  readonly getReveal = () => this.revealed;

  getOpen(): OpenImports {
    return this.open;
  }

  store(importId: string): ImportStore {
    let store = this.stores.get(importId);
    if (!store) {
      store = new ImportStore(this.projectId, importId, this.api);
      this.stores.set(importId, store);
      store.subscribe(() => this.changed());
      announceMilestones(store);
    }
    return store;
  }

  /** Imports to show a status row for: this tab's runs, then the server's open ones, newest first. */
  private computeKnown(): string[] {
    const ids = new Set<string>();
    const local = [...this.stores.values()].filter((store) => store.getSnapshot().local);
    local.sort(
      (a, b) => (this.startedAt.get(b.importId) ?? 0) - (this.startedAt.get(a.importId) ?? 0),
    );
    for (const store of local) ids.add(store.importId);
    for (const summary of this.open.summaries) ids.add(summary.importId);
    return [...ids].filter((id) => {
      const state = this.stores.get(id)?.getSnapshot();
      // Stopped before the server heard of it: nothing is left to show a row for.
      const endedHere = state?.stop === "stopped" && !state.report;
      return !(endedHere || state?.dismissing || state?.report?.summary.dismissedAt);
    });
  }

  // ---- Starting

  /** Draw the rows, answer with the id and carry on in the background. */
  start(selection: Selection, destination: ImportDestination): string {
    const importId = crypto.randomUUID();
    this.startedAt.set(importId, Date.now());
    const entryIds = new Map<string, number>();
    let next = 0;
    for (const root of selection.roots)
      for (const file of root.files) entryIds.set(`${root.rootId}\u0000${file.path}`, next++);
    const rows = clientRowsFor(selection, destination, (rootId, path) =>
      entryIds.get(`${rootId}\u0000${path}`),
    );
    const store = this.store(importId);
    store.update((state) => ({
      ...state,
      local: {
        phase: { kind: "preparing", totalBytes: bytesToHash(selection), planning: false },
        destination,
        roots: selection.roots.map(({ rootId, kind, name }) => ({ rootId, kind, name })),
        rows,
        total: rows.filter((row) => row.kind === "file").length,
        held: null,
        manifest: null,
        failures: new Map(),
        retrying: new Set(),
      },
    }));
    void this.prepareAndPlan(store, selection, destination);
    return importId;
  }

  private async prepareAndPlan(
    store: ImportStore,
    selection: Selection,
    destination: ImportDestination,
  ) {
    const run = this.runFor(store);
    let built: BuiltManifest;
    let lastPaint = 0;
    try {
      built = await buildManifest(selection, {
        importId: store.importId,
        destinationUri: destination.uri,
        signal: run.controller.signal,
        onHashed: (hashedBytes) => {
          // Progress has its own channel: the tree must not re-render for it.
          const now = performance.now();
          if (now - lastPaint < 250) return;
          lastPaint = now;
          store.setHashed(hashedBytes);
        },
      });
    } catch {
      return; // Stopped while preparing; `stop` already ended the run.
    }
    // The last files read may finish after Stop: their result is not this import's anymore.
    if (retired(run)) return;
    store.setLocal((local) => ({
      ...local,
      manifest: built.manifest,
      held: built.held,
      total: built.manifest.entries.length,
    }));
    await this.plan(store, built, run);
  }

  /** Send the plan, then the files. Also the retry for an import that did not start. */
  private async plan(store: ImportStore, built: BuiltManifest, run: Run) {
    store.setLocal((local) => ({
      ...local,
      phase: {
        kind: "preparing",
        totalBytes: local.phase.kind === "preparing" ? local.phase.totalBytes : 0,
        planning: true,
      },
    }));
    const planning = this.api.plan(this.projectId, built.manifest);
    this.plans.set(store.importId, planning);
    try {
      const answer = await planning;
      // Stop waits for this answer and installs its own finished one.
      if (retired(run)) return;
      store.installReport(answer);
    } catch (error) {
      if (retired(run)) return;
      store.setLocal((local) => ({
        ...local,
        phase: {
          kind: "not-started",
          code:
            error instanceof ImportRequestError ? (error.code ?? `status:${error.status}`) : null,
        },
      }));
      return;
    } finally {
      this.plans.delete(store.importId);
    }
    this.send(store, run);
  }

  /**
   * Continue import: adopt a checked selection for an import already on the server.
   * Resumes the plan if the server is still planning, then sends what is outstanding.
   */
  async continueImport(importId: string, built: BuiltManifest) {
    const store = this.store(importId);
    const summary = store.getSnapshot().report?.summary;
    if (!summary) return;
    const run = this.runFor(store);
    store.update((state) => ({
      ...state,
      stop: "none",
      local: {
        phase: { kind: "idle" },
        destination: state.local?.destination ?? destinationFromSummary(summary),
        roots: state.report?.roots.map(({ rootId, kind, name }) => ({ rootId, kind, name })) ?? [],
        rows: [],
        total: built.manifest.entries.length,
        held: built.held,
        manifest: built.manifest,
        failures: new Map(),
        retrying: new Set(),
      },
    }));
    if (summary.state === "planning") {
      await this.plan(store, built, run);
      return;
    }
    this.send(store, run);
  }

  /** Try again after "Import didn't start". Same id, same manifest, same files. */
  tryAgain(importId: string) {
    const store = this.store(importId);
    const local = store.getSnapshot().local;
    if (!local?.manifest || !local.held) return;
    void this.plan(
      store,
      { manifest: local.manifest, held: new Map(local.held) },
      this.runFor(store),
    );
  }

  // ---- Uploading

  /** Queue every file the server still wants and this tab holds (or just `only`). */
  private send(store: ImportStore, run: Run, only?: ReadonlySet<number>) {
    if (retired(run)) return;
    const state = store.getSnapshot();
    const { local, report } = state;
    if (!local?.manifest || !local.held || !report) return;
    const matched = matchHeld(
      { roots: report.roots, entries: report.entries.values() },
      local.manifest,
      local.held,
    );
    const files: HeldFile[] = [];
    for (const entry of report.entries.values()) {
      if (only && !only.has(entry.entryId)) continue;
      if (entry.state !== "planned" && entry.state !== "failed") continue;
      const file = matched.get(entry.entryId);
      if (file) files.push({ ...file, entryId: entry.entryId });
    }
    run.queue.add(files);
    if (run.queue.idle) this.sent(store);
    else store.setLocal((current) => ({ ...current, phase: { kind: "uploading" } }));
  }

  /** Every queued file has its answer: read what the server made of them. */
  private sent(store: ImportStore) {
    store.setLocal((current) => ({ ...current, phase: { kind: "idle" }, retrying: new Set() }));
    void store.refresh();
  }

  /** The import's live run, or a new one once Stop or a refusal retired the last. */
  private runFor(store: ImportStore): Run {
    const current = this.runs.get(store.importId);
    if (current && !retired(current)) return current;
    const controller = new AbortController();
    const run: Run = {
      controller,
      queue: new UploadQueue({
        send: (parts, signal) =>
          this.api.send(
            this.projectId,
            store.importId,
            parts.map((part) => ({
              entryId: part.entryId,
              file: part.file,
              name: part.file.name || "file",
            })),
            signal,
          ),
        onOutcome: (outcomes) => this.record(store, outcomes),
        onIdle: () => this.sent(store),
      }),
    };
    this.runs.set(store.importId, run);
    return run;
  }

  /** No more reading, planning or sending for this import from this tab. */
  private retire(importId: string) {
    const run = this.runs.get(importId);
    if (!run) return;
    run.controller.abort();
    run.queue.cancel();
    this.runs.delete(importId);
  }

  private record(store: ImportStore, outcomes: readonly UploadOutcome[]) {
    const answered = outcomes.flatMap((outcome) =>
      outcome.kind === "answered" ? [outcome.entry] : [],
    );
    if (answered.length) store.mergeEntries(answered);
    store.setLocal((local) => {
      const failures = new Map(local.failures);
      const retrying = new Set(local.retrying);
      for (const entry of answered) {
        failures.delete(entry.entryId);
        retrying.delete(entry.entryId);
      }
      for (const outcome of outcomes) {
        if (outcome.kind !== "failed") continue;
        retrying.delete(outcome.entryId);
        failures.set(outcome.entryId, failureReason(outcome.cause));
      }
      return { ...local, failures, retrying };
    });
  }

  /** Send these failed files again (or every failed file when `entryIds` is empty). */
  retry(importId: string, entryIds?: readonly number[]) {
    const store = this.store(importId);
    const { local, report } = store.getSnapshot();
    if (!local?.held || !report) return;
    const wanted = new Set(
      entryIds ??
        [...report.entries.values()]
          .filter((entry) => entry.state === "failed" || local.failures.has(entry.entryId))
          .map((entry) => entry.entryId),
    );
    if (wanted.size === 0) return;
    store.setLocal((current) => {
      const failures = new Map(current.failures);
      for (const id of wanted) failures.delete(id);
      return { ...current, failures, retrying: new Set([...current.retrying, ...wanted]) };
    });
    this.send(store, this.runFor(store), wanted);
  }

  /** Keep importing after "Couldn't stop": this tab sends what is left. */
  resume(importId: string) {
    const store = this.store(importId);
    store.update((state) => ({ ...state, stop: "none" }));
    store.setLocal((local) => ({ ...local, phase: { kind: "idle" } }));
    this.send(store, this.runFor(store));
  }

  // ---- Stopping

  /** Stop here: no more sends from this tab, then finish with what arrived. */
  async stop(importId: string) {
    const store = this.store(importId);
    this.retire(importId);
    const planning = this.plans.get(importId);
    const { report } = store.getSnapshot();
    if (!report && !planning) {
      // Nothing was ever sent: the import ends here, its rows and its status row go.
      store.update((state) => ({
        ...state,
        stop: "stopped",
        load: "idle",
        local: state.local && { ...state.local, phase: { kind: "idle" }, rows: [], held: null },
      }));
      this.changed(true);
      return "nothing-sent" as const;
    }
    store.update((state) => ({ ...state, stop: "stopping" }));
    try {
      await planning?.catch(() => {});
      store.installReport(await this.api.finish(this.projectId, importId));
      store.update((state) => ({
        ...state,
        stop: "stopped",
        local: state.local && { ...state.local, phase: { kind: "idle" }, held: null, rows: [] },
      }));
      return "stopped" as const;
    } catch {
      store.update((state) => ({ ...state, stop: "failed" }));
      return "failed" as const;
    }
  }

  // ---- Dismissing

  async dismiss(importId: string) {
    const store = this.store(importId);
    store.update((state) => ({ ...state, dismissing: true, dismissFailed: false }));
    this.changed(true);
    try {
      store.installReport(await this.api.dismiss(this.projectId, importId));
      this.open = {
        ...this.open,
        summaries: this.open.summaries.filter((s) => s.importId !== importId),
      };
      this.changed(true);
    } catch {
      store.update((state) => ({ ...state, dismissing: false, dismissFailed: true }));
      this.changed(true);
    }
  }

  // ---- The server's list of open imports

  async refreshOpen() {
    try {
      const summaries = await this.api.listOpen(this.projectId);
      for (const summary of summaries) this.store(summary.importId).seedSummary(summary);
      this.open = { summaries, loaded: true, failed: false };
    } catch {
      this.open = { ...this.open, failed: true };
    }
    this.changed();
  }

  /** Keep the list fresh while the project is open: 30 s, or 5 s while anything is importing. */
  watchOpen(): () => void {
    const tick = async () => {
      if (this.disposed) return;
      await this.refreshOpen();
      const active = this.open.summaries.some(
        (summary) => summary.state !== "finished" && summary.counts.arriving > 0,
      );
      this.openTimer = setTimeout(tick, active ? 5000 : 30_000);
    };
    void tick();
    return () => {
      if (this.openTimer) clearTimeout(this.openTimer);
      this.openTimer = undefined;
    };
  }

  isPreparingOrUploading(): boolean {
    for (const store of this.stores.values()) {
      const kind = store.getSnapshot().local?.phase.kind;
      if (kind === "preparing" || kind === "uploading") return true;
    }
    return false;
  }

  dispose() {
    this.disposed = true;
    if (this.openTimer) clearTimeout(this.openTimer);
    if (this.treeTimer) clearTimeout(this.treeTimer);
    for (const importId of [...this.runs.keys()]) this.retire(importId);
    for (const store of this.stores.values()) store.dispose();
  }
}

/** The folder an import was started on, from the server's summary alone. */
export function destinationFromSummary(summary: ImportSummary): ImportDestination {
  const uri = summary.destination.folderUri;
  const scheme = (uri.match(/^([a-z]+):\/\//)?.[1] ?? "kb") as ImportDestination["scheme"];
  const path = catalogPathOfUri(uri) ?? "/";
  return {
    scheme,
    path,
    uri,
    name: path === "/" ? areaLabel(scheme) : path.slice(path.lastIndexOf("/") + 1),
    folderId: summary.destination.folderId,
  };
}

function areaLabel(scheme: ImportDestination["scheme"]): string {
  return scheme === "manuscript"
    ? t`Manuscript`
    : scheme === "unfiled"
      ? t`Unfiled`
      : t`Knowledge Base`;
}

function retired(run: Run): boolean {
  return run.controller.signal.aborted;
}

function failureReason(cause: unknown): ImportFailureReason {
  return cause instanceof ImportRequestError && cause.status === 0
    ? "upload_failed"
    : "server_error";
}
