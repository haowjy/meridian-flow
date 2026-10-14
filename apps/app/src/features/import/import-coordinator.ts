/**
 * Runs imports for one project in this tab and owns what surfaces only read:
 * which statuses are read and when (the open-list poll, one full read, `?since=`
 * cuts, a by-id read when an import leaves the list), the per-import set of node
 * ids the catalog has held, the short bridges that cover a row until the catalog
 * shows it, the `documentId` index, and the retirement of every store. Navigate
 * first: `start` returns the import id at once and does the rest in the background.
 */
import type {
  ImportEntryStatus,
  ImportFailureReason,
  ImportFolderStatus,
  ImportStatus,
} from "@meridian/contracts";
import { ImportRequestError } from "@/client/api/imports-api";
import {
  clientRowsFor,
  nodeIdsFor,
  type RowSource,
  sourceOfManifest,
  sourceOfSelection,
} from "./client-rows";
import { matchHeld } from "./continue-check";
import type { ImportDestination } from "./destination";
import { type ImportApi, importApi } from "./import-api-port";
import { fullyRead, type ImportState } from "./import-state";
import { compareVersions, ImportStore } from "./import-store";
import { type BuiltManifest, buildManifest, type HeldFile } from "./manifest";
import { announceMilestones } from "./milestones";
import { destinationFromSummary, type ImportTarget, targetOf } from "./placements";
import type { Selection } from "./selection";
import type { ProjectedImport } from "./tree-projection";
import { type UploadOutcome, UploadQueue } from "./uploader";

/** Imports over this many files redraw the tree no more often than every few seconds. */
const BIG_IMPORT = 500;
const BIG_IMPORT_TREE_MS = 3000;
/** How long a materialized row stays drawn while waiting for the catalog to show it. */
const BRIDGE_MS = 30_000;
const POLL_ACTIVE_MS = 5000;
const POLL_IDLE_MS = 30_000;

/** The catalog, as the coordinator needs it: whether it holds a node id now, and when it changes. */
export type CatalogReader = {
  holds(id: string): boolean;
  subscribe(listener: () => void): () => void;
};

const NO_CATALOG: CatalogReader = { holds: () => false, subscribe: () => () => {} };

export type Clock = {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

const REAL_CLOCK: Clock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type TrackedImport = ProjectedImport & { target: ImportTarget | null };

export type DocumentEntry = { importId: string; entryId: number };

export type ImportsSnapshot = {
  /** Imports this tab shows: its runs first, then the server's open ones. */
  imports: readonly TrackedImport[];
  /** Which import and entry each imported document belongs to. */
  documents: ReadonlyMap<string, DocumentEntry>;
};

const EMPTY_SNAPSHOT: ImportsSnapshot = { imports: [], documents: new Map() };

/**
 * What this tab is doing for one import: reading its files, the plan and the
 * sends. `retire` ends it for good; every step after an await checks `retired`
 * before it changes anything or calls the server.
 */
type Run = { readonly controller: AbortController; readonly queue: UploadQueue };

/** The evidence the projection needs that only this tab can know. */
type Tracker = {
  seen: ReadonlySet<string>;
  /** Tracked ids the catalog has not held yet. */
  unseen: Set<string>;
  bridges: ReadonlySet<string>;
  timers: Map<string, unknown>;
};

export class ImportCoordinator {
  private readonly stores = new Map<string, ImportStore>();
  private readonly trackers = new Map<string, Tracker>();
  private readonly runs = new Map<string, Run>();
  private readonly plans = new Map<string, Promise<unknown>>();
  private readonly reads = new Map<string, Promise<void>>();
  private readonly startedAt = new Map<string, number>();
  /** Imports ended for good here: late answers about them are ignored. */
  private readonly retiredIds = new Set<string>();
  /** Imports the server no longer knows. */
  private readonly missing = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribeCatalog: () => void;
  private openTimer: unknown;
  private disposed = false;

  constructor(
    readonly projectId: string,
    private readonly api: ImportApi = importApi,
    private readonly catalog: CatalogReader = NO_CATALOG,
    private readonly clock: Clock = REAL_CLOCK,
  ) {
    this.unsubscribeCatalog = catalog.subscribe(() => this.catalogChanged());
  }

  // ---- The snapshot surfaces read

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private snapshot: ImportsSnapshot = EMPTY_SNAPSHOT;
  readonly getSnapshot = () => this.snapshot;
  private readonly tracked = new Map<string, TrackedImport>();
  private readonly targets = new Map<string, { state: ImportState; target: ImportTarget | null }>();
  private indexed = new Map<string, unknown>();
  private lastTreeUpdate = Number.NEGATIVE_INFINITY;
  private treeTimer: unknown;

  /** `structural` changes (a row appearing or going) skip the big-import throttle. */
  private changed(structural = false) {
    // A big import re-renders a big tree; let it catch up at most every few seconds.
    const now = this.clock.now();
    const big = [...this.stores.values()].some((store) => {
      const state = store.getSnapshot();
      return (
        (state.report?.entries.size ?? 0) > BIG_IMPORT ||
        (state.local?.rows.length ?? 0) > BIG_IMPORT
      );
    });
    if (!structural && big && now - this.lastTreeUpdate < BIG_IMPORT_TREE_MS) {
      this.treeTimer ??= this.clock.setTimeout(
        () => {
          this.treeTimer = undefined;
          this.changed();
        },
        BIG_IMPORT_TREE_MS - (now - this.lastTreeUpdate),
      );
      return;
    }
    if (this.treeTimer) this.clock.clearTimeout(this.treeTimer);
    this.treeTimer = undefined;
    this.lastTreeUpdate = now;
    const imports = this.computeImports();
    const documents = this.documentIndex(imports);
    const same =
      imports.length === this.snapshot.imports.length &&
      imports.every((item, index) => item === this.snapshot.imports[index]) &&
      documents === this.snapshot.documents;
    if (!same) this.snapshot = { imports, documents };
    for (const listener of [...this.listeners]) listener();
  }

  /** This tab's runs, then the server's open imports; each reused while nothing about it moved. */
  private computeImports(): TrackedImport[] {
    const live: ImportStore[] = [];
    for (const store of this.stores.values()) {
      const state = store.getSnapshot();
      // Stopped before the server heard of it: nothing is left to show a row for.
      const endedHere = state.stop === "stopped" && !state.report;
      if ((state.local || state.report) && !endedHere) live.push(store);
    }
    live.sort(
      (a, b) =>
        Number(!b.getSnapshot().local) - Number(!a.getSnapshot().local) ||
        (this.startedAt.get(b.importId) ?? 0) - (this.startedAt.get(a.importId) ?? 0),
    );
    const next = new Map<string, TrackedImport>();
    const result = live.map((store) => {
      const state = store.getSnapshot();
      const tracker = this.trackerOf(store.importId);
      let target = this.targets.get(store.importId);
      if (target?.state !== state) {
        target = { state, target: targetOf(state) };
        this.targets.set(store.importId, target);
      }
      const previous = this.tracked.get(store.importId);
      const item =
        previous &&
        previous.state === state &&
        previous.seen === tracker.seen &&
        previous.bridges === tracker.bridges &&
        previous.target === target.target
          ? previous
          : {
              importId: store.importId,
              state,
              seen: tracker.seen,
              bridges: tracker.bridges,
              target: target.target,
            };
      next.set(store.importId, item);
      return item;
    });
    this.tracked.clear();
    for (const [id, item] of next) this.tracked.set(id, item);
    return result;
  }

  /** Rebuilt only when some import's entries or the set of imports moved. */
  private documentIndex(imports: readonly TrackedImport[]): ReadonlyMap<string, DocumentEntry> {
    const seen = new Map<string, unknown>();
    for (const item of imports) seen.set(item.importId, item.state.report?.entries);
    const same =
      seen.size === this.indexed.size &&
      [...seen].every(([id, entries]) => this.indexed.get(id) === entries);
    if (same) return this.snapshot.documents;
    this.indexed = seen;
    const documents = new Map<string, DocumentEntry>();
    for (const item of imports)
      for (const entry of item.state.report?.entries.values() ?? [])
        documents.set(entry.documentId, { importId: item.importId, entryId: entry.entryId });
    return documents;
  }

  /** One import as the surfaces see it; null once it is retired. */
  view(importId: string): TrackedImport | null {
    return this.snapshot.imports.find((item) => item.importId === importId) ?? null;
  }

  store(importId: string): ImportStore {
    let store = this.stores.get(importId);
    if (!store) {
      store = new ImportStore(this.projectId, importId);
      this.stores.set(importId, store);
      announceMilestones(store);
      store.subscribe(() => {
        this.changed();
        this.maybeRetire(importId);
      });
    }
    return store;
  }

  private trackerOf(importId: string): Tracker {
    let tracker = this.trackers.get(importId);
    if (!tracker) {
      tracker = { seen: new Set(), unseen: new Set(), bridges: new Set(), timers: new Map() };
      this.trackers.set(importId, tracker);
    }
    return tracker;
  }

  // ---- Seen ids and bridges

  /** Remember node ids to watch the catalog for; the catalog may already hold them. */
  private track(importId: string, ids: Iterable<string>) {
    const tracker = this.trackerOf(importId);
    for (const id of ids) if (!tracker.seen.has(id)) tracker.unseen.add(id);
    if (this.scan(importId)) this.changed();
  }

  /** Move every tracked id the catalog now holds into the seen set; true when any moved. */
  private scan(importId: string): boolean {
    const tracker = this.trackers.get(importId);
    if (!tracker || tracker.unseen.size === 0) return false;
    const added: string[] = [];
    for (const id of tracker.unseen) if (this.catalog.holds(id)) added.push(id);
    if (added.length === 0) return false;
    for (const id of added) tracker.unseen.delete(id);
    tracker.seen = new Set([...tracker.seen, ...added]);
    let closed = false;
    for (const id of added) {
      const timer = tracker.timers.get(id);
      if (timer === undefined) continue;
      this.clock.clearTimeout(timer);
      tracker.timers.delete(id);
      closed = true;
    }
    if (closed) tracker.bridges = new Set(tracker.timers.keys());
    return true;
  }

  private catalogChanged() {
    let moved = false;
    for (const importId of [...this.trackers.keys()]) {
      if (!this.scan(importId)) continue;
      moved = true;
      this.maybeRetire(importId);
    }
    if (moved) this.changed();
  }

  /** The tab drew this node and has just learned it exists: cover it until the catalog shows it. */
  private openBridge(importId: string, id: string) {
    const tracker = this.trackerOf(importId);
    if (tracker.seen.has(id) || tracker.timers.has(id)) return;
    tracker.timers.set(
      id,
      this.clock.setTimeout(() => {
        tracker.timers.delete(id);
        tracker.bridges = new Set(tracker.timers.keys());
        this.changed(true);
        this.maybeRetire(importId);
      }, BRIDGE_MS),
    );
    tracker.bridges = new Set(tracker.timers.keys());
  }

  /**
   * Take in what a status read or an upload answer said: watch its node ids, and
   * bridge a drawn code or binary file that has just landed.
   */
  private absorb(
    importId: string,
    delta: { folders: readonly ImportFolderStatus[]; entries: readonly ImportEntryStatus[] },
    before: ReadonlyMap<number, ImportEntryStatus> | undefined,
  ) {
    this.track(importId, [
      ...delta.folders.map((folder) => folder.id),
      ...delta.entries.map((entry) => entry.documentId),
    ]);
    for (const entry of delta.entries) {
      const prior = before?.get(entry.entryId);
      if (
        prior &&
        entry.state === "landed" &&
        (prior.state === "planned" || prior.state === "landing" || prior.state === "failed") &&
        (entry.kind === "code" || entry.kind === "binary")
      )
        this.openBridge(importId, entry.documentId);
    }
  }

  /** The plan answered: the status replaces the prediction, and drawn plan-time rows are bridged. */
  private accept(store: ImportStore, answer: ImportStatus) {
    const importId = store.importId;
    const before = store.getSnapshot().report?.entries;
    const rows = store.getSnapshot().local?.rows ?? [];
    // Bridges open before the store changes: a store retires as soon as it is over.
    this.absorb(importId, answer, before);
    const materialized = new Set<string>();
    for (const folder of answer.folders)
      if (folder.state !== "deleted") materialized.add(folder.id);
    for (const entry of answer.entries)
      if (entry.kind === "note" || entry.kind === "docx" || entry.state === "landed")
        if (entry.state !== "skipped" && entry.state !== "deleted")
          materialized.add(entry.documentId);
    for (const row of rows) if (materialized.has(row.id)) this.openBridge(importId, row.id);
    store.installReport(answer);
    store.setLocal((local) => ({ ...local, rows: [] }));
  }

  // ---- Starting

  /** Answer with the id at once; the rows, the plan and the sends follow in the background. */
  start(selection: Selection, destination: ImportDestination): string {
    const importId = crypto.randomUUID();
    this.startedAt.set(importId, Date.now());
    const store = this.store(importId);
    store.update((state) => ({
      ...state,
      local: {
        phase: { kind: "preparing" },
        destination,
        roots: selection.roots.map(({ rootId, kind, name }) => ({ rootId, kind, name })),
        rows: [],
        held: null,
        manifest: null,
        failures: new Map(),
        retrying: new Set(),
      },
    }));
    void this.prepareAndPlan(store, selection, destination);
    return importId;
  }

  /** Draw the rows for `source`, unless the run ended while their ids were derived. */
  private async drawRows(
    store: ImportStore,
    run: Run,
    source: RowSource,
    destination: ImportDestination,
    ids: ReturnType<typeof nodeIdsFor>,
  ) {
    const rows = await clientRowsFor(source, destination, ids);
    if (retired(run)) return;
    store.setLocal((local) => ({ ...local, rows }));
    this.track(
      store.importId,
      rows.map((row) => row.id),
    );
  }

  private async prepareAndPlan(
    store: ImportStore,
    selection: Selection,
    destination: ImportDestination,
  ) {
    const run = this.runFor(store);
    const ids = nodeIdsFor(this.projectId, store.importId);
    // Hashing and deriving the rows' ids run together.
    const building = buildManifest(selection, {
      importId: store.importId,
      destinationUri: destination.uri,
      signal: run.controller.signal,
    });
    building.catch(() => {});
    await this.drawRows(store, run, sourceOfSelection(selection), destination, ids);
    let built: BuiltManifest;
    try {
      built = await building;
    } catch {
      return; // Stopped while preparing; `stop` already ended the run.
    }
    // The last files read may finish after Stop: their result is not this import's anymore.
    if (retired(run)) return;
    // Files that could not be read, and folders only they implied, are not rows.
    await this.drawRows(store, run, sourceOfManifest(built.manifest), destination, ids);
    if (retired(run)) return;
    store.setLocal((local) => ({ ...local, manifest: built.manifest, held: built.held }));
    await this.plan(store, built, run);
  }

  /** Send the plan, then the files. Also the retry for an import that did not start. */
  private async plan(store: ImportStore, built: BuiltManifest, run: Run) {
    store.setLocal((local) => ({
      ...local,
      phase: { kind: "preparing" },
    }));
    const planning = this.api.plan(this.projectId, built.manifest);
    this.plans.set(store.importId, planning);
    try {
      const answer = await planning;
      // Stop waits for this answer and installs its own finished one.
      if (retired(run)) return;
      this.accept(store, answer);
    } catch (error) {
      if (retired(run)) return;
      store.setLocal((local) => ({
        ...local,
        phase: {
          kind: "not-started",
          code: error instanceof ImportRequestError ? error.code : null,
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
      if (!entry.wanted) continue;
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
    void this.read(store.importId);
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
  private endRun(importId: string) {
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
    if (answered.length) {
      this.absorb(
        store.importId,
        { folders: [], entries: answered },
        store.getSnapshot().report?.entries,
      );
      store.mergeEntries(answered);
    }
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
    this.endRun(importId);
    const planning = this.plans.get(importId);
    const { report } = store.getSnapshot();
    if (!report && !planning) {
      // Nothing was ever sent: the import ends here, its rows and its status row go.
      store.update((state) => ({
        ...state,
        stop: "stopped",
        local: state.local && { ...state.local, phase: { kind: "idle" }, rows: [], held: null },
      }));
      this.retire(importId);
      return "nothing-sent" as const;
    }
    store.update((state) => ({ ...state, stop: "stopping" }));
    try {
      await planning?.catch(() => {});
      this.accept(store, await this.api.finish(this.projectId, importId));
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

  // ---- Reading statuses

  /**
   * Read an import's status: in full the first time or when forced (roots and lapsed
   * claims change without moving the version), else only what changed since the cursor.
   */
  read(importId: string, full = false): Promise<void> {
    const prior = this.reads.get(importId);
    if (prior && !full) return prior;
    const next = (async () => {
      await prior?.catch(() => {});
      await this.readNow(importId, full);
    })();
    this.reads.set(importId, next);
    void next.then(
      () => this.reads.get(importId) === next && this.reads.delete(importId),
      () => this.reads.get(importId) === next && this.reads.delete(importId),
    );
    return next;
  }

  private async readNow(importId: string, full: boolean) {
    const store = this.stores.get(importId);
    if (!store || this.retiredIds.has(importId) || this.disposed) return;
    const report = store.getSnapshot().report;
    try {
      if (fullyRead(report) && !full) {
        const changes = await this.api.changes(this.projectId, importId, report.cursor);
        if (this.retiredIds.has(importId)) return;
        this.merge(store, changes, (into) => into.applyChanges(changes));
      } else {
        const status = await this.api.status(this.projectId, importId);
        if (this.retiredIds.has(importId)) return;
        this.merge(store, status, (into) => into.installReport(status));
      }
    } catch (error) {
      // A failed read leaves the last good one on screen; the next poll tries again.
      if (error instanceof ImportRequestError && error.status === 404) this.gone(importId);
    }
  }

  private merge(
    store: ImportStore,
    delta: { folders: ImportFolderStatus[]; entries: ImportEntryStatus[] },
    apply: (store: ImportStore) => void,
  ) {
    this.absorb(store.importId, delta, store.getSnapshot().report?.entries);
    apply(store);
  }

  /** The server has no such import: nothing more to show or read. */
  private gone(importId: string) {
    this.missing.add(importId);
    this.maybeRetire(importId);
  }

  /** Read every open import (once in full, then by cut) and the ones that left the list. */
  async refreshOpen() {
    let summaries: Awaited<ReturnType<ImportApi["listOpen"]>>;
    try {
      summaries = await this.api.listOpen(this.projectId);
    } catch {
      return;
    }
    if (this.disposed) return;
    const listed = new Set<string>();
    for (const summary of summaries) {
      if (this.retiredIds.has(summary.importId)) continue;
      listed.add(summary.importId);
      const store = this.store(summary.importId);
      store.seedSummary(summary);
      const report = store.getSnapshot().report;
      if (!fullyRead(report)) void this.read(summary.importId, true);
      else if (compareVersions(summary.version, report.cursor) > 0)
        void this.read(summary.importId);
    }
    // Another tab finished or stopped it: the list stops saying so, only the import can.
    for (const [importId, store] of this.stores) {
      const report = store.getSnapshot().report;
      if (listed.has(importId) || !report || report.summary.state === "finished") continue;
      if (this.missing.has(importId)) continue;
      void this.read(importId, true);
    }
    this.changed();
  }

  /** Keep the list fresh while the project is open: 30 s, or 5 s while anything is importing. */
  watchOpen(): () => void {
    const tick = async () => {
      if (this.disposed) return;
      await this.refreshOpen();
      const active = [...this.stores.values()].some((store) => {
        const summary = store.getSnapshot().report?.summary;
        return summary !== undefined && summary.state !== "finished" && summary.counts.arriving > 0;
      });
      this.openTimer = this.clock.setTimeout(tick, active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    void tick();
    return () => {
      if (this.openTimer) this.clock.clearTimeout(this.openTimer);
      this.openTimer = undefined;
    };
  }

  // ---- Retirement

  /**
   * A store retires when its import is over (finished, or gone from the server), no
   * command is in flight and no bridge is open. The catalog never has to move first:
   * in an idle project the final landing's own publication may be the last commit.
   */
  private maybeRetire(importId: string) {
    const store = this.stores.get(importId);
    if (!store) return;
    const state = store.getSnapshot();
    const over = state.report?.summary.state === "finished" || this.missing.has(importId);
    if (!over || this.plans.has(importId) || state.stop === "stopping") return;
    const phase = state.local?.phase.kind;
    if (phase === "preparing" || phase === "uploading") return;
    if (this.trackers.get(importId)?.timers.size) return;
    this.retire(importId);
  }

  /** End the import here for good: abort its run, release its files and forget it. */
  private retire(importId: string) {
    this.endRun(importId);
    this.retiredIds.add(importId);
    const tracker = this.trackers.get(importId);
    for (const timer of tracker?.timers.values() ?? []) this.clock.clearTimeout(timer);
    this.trackers.delete(importId);
    this.tracked.delete(importId);
    this.targets.delete(importId);
    this.reads.delete(importId);
    this.stores.get(importId)?.dispose();
    this.stores.delete(importId);
    this.changed(true);
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
    this.unsubscribeCatalog();
    if (this.openTimer) this.clock.clearTimeout(this.openTimer);
    if (this.treeTimer) this.clock.clearTimeout(this.treeTimer);
    for (const tracker of this.trackers.values())
      for (const timer of tracker.timers.values()) this.clock.clearTimeout(timer);
    for (const importId of [...this.runs.keys()]) this.endRun(importId);
    for (const store of this.stores.values()) store.dispose();
  }
}

function retired(run: Run): boolean {
  return run.controller.signal.aborted;
}

function failureReason(cause: unknown): ImportFailureReason {
  return cause instanceof ImportRequestError && cause.status === 0
    ? "upload_failed"
    : "server_error";
}
