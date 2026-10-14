/**
 * Runs imports for one project in this tab and owns what surfaces only read:
 * which statuses are read and when (the open-list poll, one full read, `?since=`
 * cuts, a by-id read when an import leaves the list), the `documentId` index and
 * the retirement of every import. Each import lives in one `ImportRecord`. Navigate
 * first: `begin` returns the import id before the selection is read and does the
 * rest in the background.
 *
 * Every answer that arrives after an await is fenced twice before it touches
 * anything: by the coordinator's lifetime (`epoch`, which `dispose` advances, since
 * `watchOpen` revives the same object) and by the import's current record.
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
import type { ImportDestination } from "./destination";
import { type ImportApi, importApi } from "./import-api-port";
import type { CatalogReader, Clock } from "./import-handoff";
import { ImportRecord, type Run, retired } from "./import-record";
import { fullyRead } from "./import-state";
import { compareVersions, type ImportStore } from "./import-store";
import { type BuiltManifest, buildManifest, type HeldFile } from "./manifest";
import { announceMilestones } from "./milestones";
import { destinationFromSummary } from "./placements";
import type { Selection } from "./selection";
import type { ProjectedImport } from "./tree-projection";
import { type UploadOutcome, UploadQueue } from "./uploader";

/** Imports over this many files redraw the tree no more often than every few seconds. */
const BIG_IMPORT = 500;
const BIG_IMPORT_TREE_MS = 3000;
const POLL_ACTIVE_MS = 5000;
const POLL_IDLE_MS = 30_000;

const NO_CATALOG: CatalogReader = { holds: () => false, subscribe: () => () => {} };

const REAL_CLOCK: Clock = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export type DocumentEntry = { importId: string; entryId: number };

export type ImportsSnapshot = {
  /** Imports this tab shows: its runs first, then the server's open ones. */
  imports: readonly ProjectedImport[];
  /** Which import and entry each imported document belongs to. */
  documents: ReadonlyMap<string, DocumentEntry>;
};

const EMPTY_SNAPSHOT: ImportsSnapshot = { imports: [], documents: new Map() };

/**
 * Reads what the writer chose, with the run's abort signal and a running count.
 * Null means nothing to import (the caller has already said why).
 */
export type SelectionRead = (options: {
  signal: AbortSignal;
  onProgress: (count: number, name: string) => void;
}) => Promise<Selection | null>;

/** Reading progress repaints the tree no more often than this. */
const READ_PAINT_MS = 250;

/** An entry in one of these states has its answer for good: the tab no longer needs its file. */
const FINAL_STATES: ReadonlySet<ImportEntryStatus["state"]> = new Set([
  "landed",
  "deleted",
  "not_imported",
  "skipped",
]);

export class ImportCoordinator {
  private readonly records = new Map<string, ImportRecord>();
  /** Imports ended for good here: late answers about them are ignored. */
  private readonly retiredIds = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private unsubscribeCatalog: (() => void) | undefined;
  private openTimer: unknown;
  private disposed = false;
  /** Advances on `dispose`: an answer begun in an earlier lifetime is dropped. */
  private epoch = 0;
  /** Which `watchOpen` call owns the poll loop. */
  private watching = 0;

  constructor(
    readonly projectId: string,
    private readonly api: ImportApi = importApi,
    private readonly catalog: CatalogReader = NO_CATALOG,
    private readonly clock: Clock = REAL_CLOCK,
  ) {}

  // ---- The snapshot surfaces read

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private snapshot: ImportsSnapshot = EMPTY_SNAPSHOT;
  readonly getSnapshot = () => this.snapshot;
  private indexed = new Map<string, unknown>();
  private lastTreeUpdate = Number.NEGATIVE_INFINITY;
  private treeTimer: unknown;

  /** `structural` changes (a row appearing or going) skip the big-import throttle. */
  private changed(structural = false) {
    // A big import re-renders a big tree; let it catch up at most every few seconds.
    const now = this.clock.now();
    const big = [...this.records.values()].some((record) => {
      const state = record.store.getSnapshot();
      return (
        (state.status?.entries.size ?? 0) > BIG_IMPORT ||
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
  private computeImports(): ProjectedImport[] {
    const live: ImportRecord[] = [];
    for (const record of this.records.values()) {
      const state = record.store.getSnapshot();
      // Stopped before the server heard of it: nothing is left to show a row for.
      const endedHere = state.stop === "stopped" && !state.status;
      if ((state.local || state.status) && !endedHere) live.push(record);
    }
    live.sort(
      (a, b) =>
        Number(!b.store.getSnapshot().local) - Number(!a.store.getSnapshot().local) ||
        b.startedAt - a.startedAt,
    );
    return live.map((record) => record.project());
  }

  /** Rebuilt only when some import's entries or the set of imports moved. */
  private documentIndex(imports: readonly ProjectedImport[]): ReadonlyMap<string, DocumentEntry> {
    const seen = new Map<string, unknown>();
    for (const item of imports) seen.set(item.importId, item.state.status?.entries);
    const same =
      seen.size === this.indexed.size &&
      [...seen].every(([id, entries]) => this.indexed.get(id) === entries);
    if (same) return this.snapshot.documents;
    this.indexed = seen;
    const documents = new Map<string, DocumentEntry>();
    for (const item of imports)
      for (const entry of item.state.status?.entries.values() ?? [])
        documents.set(entry.documentId, { importId: item.importId, entryId: entry.entryId });
    return documents;
  }

  /** One import as the surfaces see it; null once it is retired. */
  view(importId: string): ProjectedImport | null {
    return this.snapshot.imports.find((item) => item.importId === importId) ?? null;
  }

  store(importId: string): ImportStore {
    return this.recordOf(importId).store;
  }

  private recordOf(importId: string): ImportRecord {
    let record = this.records.get(importId);
    if (!record) {
      const created: ImportRecord = new ImportRecord(
        this.projectId,
        importId,
        this.catalog,
        this.clock,
        () => this.expired(created),
      );
      record = created;
      this.records.set(importId, created);
      announceMilestones(created.store);
      created.store.subscribe(() => {
        this.changed();
        this.maybeRetire(created);
      });
    }
    return record;
  }

  /** Whether `record` is still this import's record in the lifetime the caller began in. */
  private live(record: ImportRecord, epoch: number): boolean {
    return !this.disposed && epoch === this.epoch && this.records.get(record.importId) === record;
  }

  // ---- Seen ids and bridges

  private track(record: ImportRecord, ids: Iterable<string>) {
    if (record.handoff.track(ids)) this.changed();
  }

  private catalogChanged() {
    let moved = false;
    let retiredAny = false;
    for (const record of [...this.records.values()]) {
      if (!record.handoff.scan()) continue;
      moved = true;
      retiredAny = this.maybeRetire(record, false) || retiredAny;
    }
    if (moved) this.changed(retiredAny);
  }

  /** A batch of bridges ran out: one publication, and the import may be over. */
  private expired(record: ImportRecord) {
    if (this.records.get(record.importId) !== record) return;
    if (!this.maybeRetire(record)) this.changed(true);
  }

  /**
   * Take in what a status read or an upload answer said: watch its node ids, bridge
   * the drawn code and binary files that have just landed, and let go of the file of
   * every entry that has its final answer.
   */
  private absorb(
    record: ImportRecord,
    delta: { folders: readonly ImportFolderStatus[]; entries: readonly ImportEntryStatus[] },
    before: ReadonlyMap<number, ImportEntryStatus> | undefined,
  ) {
    const landed: string[] = [];
    const held = record.store.getSnapshot().local?.held;
    for (const entry of delta.entries) {
      const prior = before?.get(entry.entryId);
      if (
        prior &&
        entry.state === "landed" &&
        (prior.state === "planned" || prior.state === "landing" || prior.state === "failed") &&
        (entry.kind === "code" || entry.kind === "binary")
      )
        landed.push(entry.documentId);
      if (FINAL_STATES.has(entry.state)) held?.delete(entry.entryId);
    }
    this.track(record, [
      ...delta.folders.map((folder) => folder.id),
      ...delta.entries.map((entry) => entry.documentId),
    ]);
    record.handoff.open(landed);
  }

  /**
   * A full status replaces whatever was predicted: the single place a first
   * acceptance happens, whether the plan answered or a poll found the import first.
   * Rows this tab drew that the status materialized are bridged before the store
   * changes, since a store retires as soon as it is over.
   */
  private installFull(record: ImportRecord, incoming: ImportStatus) {
    const { status: current, local } = record.store.getSnapshot();
    this.absorb(record, incoming, current?.entries);
    if (!fullyRead(current) && local?.rows.length) {
      const materialized = new Set<string>();
      for (const folder of incoming.folders)
        if (folder.state !== "deleted") materialized.add(folder.id);
      for (const entry of incoming.entries)
        if (entry.kind === "note" || entry.kind === "docx" || entry.state === "landed")
          if (entry.state !== "skipped" && entry.state !== "deleted")
            materialized.add(entry.documentId);
      record.handoff.open(
        local.rows.filter((row) => materialized.has(row.id)).map((row) => row.id),
      );
    }
    record.store.installStatus(incoming);
  }

  /** The plan answered: the status replaces the prediction. */
  private accept(record: ImportRecord, answer: ImportStatus) {
    this.installFull(record, answer);
    record.store.setLocal((local) => ({ ...local, rows: [] }));
  }

  // ---- Beginning

  /**
   * The import exists from the moment the writer picks: its run, abort signal and
   * destination row come first, then `read` fills in the selection. Null when the
   * coordinator is disposed.
   */
  begin(destination: ImportDestination, read: SelectionRead): string | null {
    if (this.disposed) return null;
    const record = this.recordOf(crypto.randomUUID());
    record.store.update((state) => ({
      ...state,
      local: {
        phase: { kind: "reading", count: 0 },
        destination,
        roots: [],
        rows: [],
        held: null,
        manifest: null,
        failures: new Map(),
        retrying: new Set(),
      },
    }));
    void this.readAndPlan(record, this.runFor(record), destination, read);
    return record.importId;
  }

  private async readAndPlan(
    record: ImportRecord,
    run: Run,
    destination: ImportDestination,
    read: SelectionRead,
  ) {
    let lastPaint = this.clock.now();
    let selection: Selection | null = null;
    try {
      selection = await read({
        signal: run.controller.signal,
        onProgress: (count) => {
          const now = this.clock.now();
          if (retired(run) || now - lastPaint < READ_PAINT_MS) return;
          lastPaint = now;
          record.store.setLocal((local) => ({ ...local, phase: { kind: "reading", count } }));
        },
      });
    } catch {
      // An unreadable selection ends the run the same way as an empty one.
    }
    if (retired(run)) return;
    if (!selection) {
      this.endLocally(record);
      return;
    }
    const roots = selection.roots.map(({ rootId, kind, name }) => ({ rootId, kind, name }));
    record.store.setLocal((local) => ({ ...local, roots, phase: { kind: "preparing" } }));
    await this.prepareAndPlan(record, run, selection, destination);
  }

  /** Draw the predicted rows for `source`. */
  private drawRows(
    record: ImportRecord,
    run: Run,
    source: RowSource,
    destination: ImportDestination,
    ids: ReturnType<typeof nodeIdsFor>,
  ) {
    const rows = clientRowsFor(source, destination, ids);
    if (retired(run)) return;
    record.store.setLocal((local) => ({ ...local, rows }));
    this.track(
      record,
      rows.map((row) => row.id),
    );
  }

  private async prepareAndPlan(
    record: ImportRecord,
    run: Run,
    selection: Selection,
    destination: ImportDestination,
  ) {
    const ids = nodeIdsFor(this.projectId, record.importId);
    const building = buildManifest(selection, {
      importId: record.importId,
      destinationUri: destination.uri,
      signal: run.controller.signal,
    });
    building.catch(() => {});
    this.drawRows(record, run, sourceOfSelection(selection), destination, ids);
    let built: BuiltManifest;
    try {
      built = await building;
    } catch {
      return; // Stopped while preparing; `stop` already ended the run.
    }
    // The last files read may finish after Stop: their result is not this import's anymore.
    if (retired(run)) return;
    // Files that could not be read, and folders only they implied, are not rows.
    this.drawRows(record, run, sourceOfManifest(built.manifest), destination, ids);
    if (retired(run)) return;
    record.store.setLocal((local) => ({ ...local, manifest: built.manifest, held: built.held }));
    await this.plan(record, built, run);
  }

  /** Send the plan, then the files. Also the retry for an import that did not start. */
  private async plan(record: ImportRecord, built: BuiltManifest, run: Run) {
    record.store.setLocal((local) => ({ ...local, phase: { kind: "preparing" } }));
    const planning = this.api.plan(this.projectId, built.manifest);
    record.plan = planning;
    try {
      const answer = await planning;
      // Stop waits for this answer and installs its own finished one.
      if (retired(run)) return;
      this.accept(record, answer);
    } catch (error) {
      if (retired(run)) return;
      record.store.setLocal((local) => ({
        ...local,
        phase: {
          kind: "not-started",
          code: error instanceof ImportRequestError ? error.code : null,
        },
      }));
      return;
    } finally {
      if (record.plan === planning) record.plan = null;
    }
    this.send(record, run);
  }

  /**
   * Continue import: adopt files already checked against the stored import, keyed
   * by its entry ids. Resumes the plan if the server is still planning, then reads
   * the import fresh and sends what it marks wanted. False, with the import as it
   * was, when the fresh read or the resume did not succeed.
   */
  async continueImport(importId: string, held: ReadonlyMap<number, HeldFile>): Promise<boolean> {
    const record = this.recordOf(importId);
    const { store } = record;
    const before = store.getSnapshot();
    const summary = before.status?.summary;
    if (!summary) return false;
    const run = this.runFor(record);
    store.update((state) => ({
      ...state,
      stop: "none",
      local: {
        phase: { kind: "idle" },
        destination: state.local?.destination ?? destinationFromSummary(summary),
        roots: state.status?.roots.map(({ rootId, kind, name }) => ({ rootId, kind, name })) ?? [],
        rows: [],
        held: new Map(held),
        manifest: null,
        failures: new Map(),
        retrying: new Set(),
      },
    }));
    const ok =
      (summary.state !== "planning" || (await this.resumePlan(record, run))) &&
      (await this.sendWanted(record, run));
    if (!ok && this.records.get(importId) === record)
      store.update((state) => ({ ...state, stop: before.stop, local: before.local }));
    return ok;
  }

  /** Ask the server to finish planning from what it stored. False when it could not. */
  private async resumePlan(record: ImportRecord, run: Run): Promise<boolean> {
    const epoch = this.epoch;
    record.store.setLocal((local) => ({ ...local, phase: { kind: "preparing" } }));
    try {
      const answer = await this.api.resume(this.projectId, record.importId, run.controller.signal);
      if (retired(run) || !this.live(record, epoch)) return false;
      this.installFull(record, answer);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One fresh full read, then send what it marks wanted (or just `only`). False
   * when there is no fresh read to send from: nothing is sent.
   */
  private async sendWanted(
    record: ImportRecord,
    run: Run,
    only?: ReadonlySet<number>,
  ): Promise<boolean> {
    if (!(await this.readFull(record))) return false;
    this.send(record, run, only);
    return true;
  }

  /** Try again after "Import didn't start". Same id, same manifest, same files. */
  tryAgain(importId: string) {
    const record = this.recordOf(importId);
    const local = record.store.getSnapshot().local;
    if (local?.phase.kind !== "not-started" || !local.manifest || !local.held) return;
    void this.plan(
      record,
      { manifest: local.manifest, held: new Map(local.held) },
      this.runFor(record),
    );
  }

  /**
   * Give up on an import that did not start. After a definite refusal the server
   * holds nothing and this ends locally. After a lost answer it may hold the
   * import, so `finish` closes it first; even a 404 is no proof it never will
   * (the create may not have committed yet), so the id stays open to the list poll.
   */
  async discard(importId: string) {
    const record = this.records.get(importId);
    const phase = record?.store.getSnapshot().local?.phase;
    if (!record || phase?.kind !== "not-started") return;
    const epoch = this.epoch;
    record.endRun();
    if (phase.code !== null) {
      this.endLocally(record);
      return;
    }
    let closed = true;
    try {
      await this.api.finish(this.projectId, importId);
    } catch {
      closed = false;
    }
    if (!this.live(record, epoch)) return;
    this.endLocally(record);
    if (!closed) this.retiredIds.delete(importId);
  }

  // ---- Uploading

  /**
   * Queue every file the server wants (or just `only`), looked up by entry id. A
   * wanted entry this tab holds no file for fails locally, never as an empty queue.
   */
  private send(record: ImportRecord, run: Run, only?: ReadonlySet<number>) {
    if (retired(run)) return;
    const { store } = record;
    const { local, status } = store.getSnapshot();
    if (!local?.held || !status) return;
    const files: HeldFile[] = [];
    const missing: number[] = [];
    for (const entry of status.entries.values()) {
      if (only && !only.has(entry.entryId)) continue;
      if (!entry.wanted) continue;
      const file = local.held.get(entry.entryId);
      if (file) files.push({ ...file, entryId: entry.entryId });
      else missing.push(entry.entryId);
    }
    if (missing.length)
      store.setLocal((current) => {
        const failures = new Map(current.failures);
        const retrying = new Set(current.retrying);
        for (const entryId of missing) {
          failures.set(entryId, "upload_failed");
          retrying.delete(entryId);
        }
        return { ...current, failures, retrying };
      });
    run.queue.add(files);
    if (run.queue.idle) this.sent(record);
    else store.setLocal((current) => ({ ...current, phase: { kind: "uploading" } }));
  }

  /** Every queued file has its answer: read what the server made of them. */
  private sent(record: ImportRecord) {
    record.store.setLocal((current) => ({
      ...current,
      phase: { kind: "idle" },
      retrying: new Set(),
    }));
    void this.readOf(record, false);
  }

  /** The import's live run, or a new one once Stop or a refusal retired the last. */
  private runFor(record: ImportRecord): Run {
    const current = record.run;
    if (current && !retired(current)) return current;
    const run: Run = {
      controller: new AbortController(),
      queue: new UploadQueue({
        send: (parts, signal) =>
          this.api.send(
            this.projectId,
            record.importId,
            parts.map((part) => ({
              entryId: part.entryId,
              file: part.file,
              name: part.file.name || "file",
            })),
            signal,
          ),
        onOutcome: (outcomes) => this.answered(record, outcomes),
        onIdle: () => this.sent(record),
      }),
    };
    record.run = run;
    return run;
  }

  private answered(record: ImportRecord, outcomes: readonly UploadOutcome[]) {
    const { store } = record;
    const answered = outcomes.flatMap((outcome) =>
      outcome.kind === "answered" ? [outcome.entry] : [],
    );
    if (answered.length) {
      this.absorb(record, { folders: [], entries: answered }, store.getSnapshot().status?.entries);
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

  /**
   * Send these failed files again (or every failed file when `entryIds` is empty).
   * The files go only after a successful fresh read; when it fails the rows keep
   * their failure, with an error saying the retry could not start.
   */
  async retry(importId: string, entryIds?: readonly number[]) {
    const record = this.recordOf(importId);
    const { store } = record;
    const { local, status } = store.getSnapshot();
    if (!local?.held || !status) return;
    const wanted = new Set(
      entryIds ??
        [...status.entries.values()]
          .filter((entry) => entry.state === "failed" || local.failures.has(entry.entryId))
          .map((entry) => entry.entryId),
    );
    if (wanted.size === 0) return;
    store.setLocal((current) => {
      const failures = new Map(current.failures);
      for (const id of wanted) failures.delete(id);
      return { ...current, failures, retrying: new Set([...current.retrying, ...wanted]) };
    });
    if (await this.sendWanted(record, this.runFor(record), wanted)) return;
    if (this.records.get(importId) !== record) return;
    store.setLocal((current) => {
      const failures = new Map(current.failures);
      const retrying = new Set(current.retrying);
      for (const id of wanted) {
        failures.set(id, "server_error");
        retrying.delete(id);
      }
      return { ...current, failures, retrying };
    });
  }

  /** Keep importing after "Couldn't stop": this tab sends what is left. */
  async resume(importId: string) {
    const record = this.recordOf(importId);
    const { store } = record;
    const before = store.getSnapshot();
    store.update((state) => ({ ...state, stop: "none" }));
    store.setLocal((local) => ({ ...local, phase: { kind: "idle" } }));
    if (await this.sendWanted(record, this.runFor(record))) return;
    if (this.records.get(importId) === record)
      store.update((state) => ({
        ...state,
        stop: before.stop,
        local: state.local && { ...state.local, phase: before.local?.phase ?? state.local.phase },
      }));
  }

  // ---- Stopping

  /** Stop here: no more sends from this tab, then finish with what arrived. */
  async stop(importId: string) {
    const record = this.recordOf(importId);
    const { store } = record;
    const epoch = this.epoch;
    record.endRun();
    const planning = record.plan;
    const { status } = store.getSnapshot();
    if (!status && !planning) {
      // Nothing was ever sent: the import ends here, its rows and its status row go.
      this.endLocally(record);
      return "nothing-sent" as const;
    }
    store.update((state) => ({ ...state, stop: "stopping" }));
    try {
      await planning?.catch(() => {});
      const answer = await this.api.finish(this.projectId, importId);
      if (!this.live(record, epoch)) return "failed" as const;
      this.accept(record, answer);
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

  /** The import ended before the server heard of it: its rows and its status row go. */
  private endLocally(record: ImportRecord) {
    record.store.update((state) => ({
      ...state,
      stop: "stopped",
      local: state.local && { ...state.local, phase: { kind: "idle" }, rows: [], held: null },
    }));
    this.retire(record);
  }

  // ---- Reading statuses

  /**
   * Read an import's status: in full the first time or when forced (roots and lapsed
   * claims change without moving the version), else only what changed since the cursor.
   * True when the read was applied.
   */
  read(importId: string, full = false): Promise<boolean> {
    const record = this.records.get(importId);
    return record ? this.readOf(record, full) : Promise.resolve(false);
  }

  /** A command's read: whole and fresh, queued behind any read already running. */
  private readFull(record: ImportRecord): Promise<boolean> {
    return this.readOf(record, true);
  }

  private readOf(record: ImportRecord, full: boolean): Promise<boolean> {
    const prior = record.read;
    if (prior && !full) return prior;
    const epoch = this.epoch;
    const next = (async () => {
      await prior?.catch(() => {});
      return this.readNow(record, full, epoch);
    })();
    record.read = next;
    void next.finally(() => {
      if (record.read === next) record.read = null;
    });
    return next;
  }

  private async readNow(record: ImportRecord, full: boolean, epoch: number): Promise<boolean> {
    if (!this.live(record, epoch)) return false;
    const { store } = record;
    const status = store.getSnapshot().status;
    try {
      if (fullyRead(status) && !full) {
        const changes = await this.api.changes(this.projectId, record.importId, status.cursor);
        if (!this.live(record, epoch)) return false;
        this.absorb(record, changes, store.getSnapshot().status?.entries);
        store.applyChanges(changes);
      } else {
        const status = await this.api.status(this.projectId, record.importId);
        if (!this.live(record, epoch)) return false;
        this.installFull(record, status);
      }
      return true;
    } catch (error) {
      // A failed read leaves the last good one on screen; a background poll tries again
      // and a command reports it.
      if (!this.live(record, epoch)) return false;
      if (error instanceof ImportRequestError && error.status === 404) {
        record.missing = true;
        this.maybeRetire(record);
      }
      return false;
    }
  }

  /** Read every open import (once in full, then by cut) and the ones that left the list. */
  async refreshOpen() {
    const epoch = this.epoch;
    let summaries: Awaited<ReturnType<ImportApi["listOpen"]>>;
    try {
      summaries = await this.api.listOpen(this.projectId);
    } catch {
      return;
    }
    if (this.disposed || epoch !== this.epoch) return;
    const listed = new Set<string>();
    for (const summary of summaries) {
      if (this.retiredIds.has(summary.importId)) continue;
      listed.add(summary.importId);
      const record = this.recordOf(summary.importId);
      record.store.seedSummary(summary);
      const status = record.store.getSnapshot().status;
      if (!fullyRead(status)) void this.readOf(record, true);
      else if (compareVersions(summary.version, status.cursor) > 0) void this.readOf(record, false);
    }
    // Another tab finished or stopped it: the list stops saying so, only the import can.
    for (const [importId, record] of this.records) {
      const status = record.store.getSnapshot().status;
      if (listed.has(importId) || !status || status.summary.state === "finished") continue;
      if (record.missing) continue;
      void this.readOf(record, true);
    }
    this.changed();
  }

  /**
   * Begin this coordinator's life: follow the catalog for the handoff. Construction
   * attaches nothing, so a render React discards leaves nothing behind. The returned
   * function ends the life; starting again after it begins a fresh one.
   */
  start(): () => void {
    this.disposed = false;
    this.unsubscribeCatalog ??= this.catalog.subscribe(() => this.catalogChanged());
    return () => this.dispose();
  }

  /**
   * Keep the list fresh while the project is open: 30 s, or 5 s while anything is
   * importing. The returned function disposes the coordinator; watching again
   * (React re-runs effects in development) brings a fresh one back to life.
   */
  watchOpen(): () => void {
    const stop = this.start();
    const generation = ++this.watching;
    const tick = async () => {
      if (this.disposed || generation !== this.watching) return;
      await this.refreshOpen();
      if (this.disposed || generation !== this.watching) return;
      const active = [...this.records.values()].some((record) => {
        const summary = record.store.getSnapshot().status?.summary;
        return summary !== undefined && summary.state !== "finished" && summary.counts.arriving > 0;
      });
      this.openTimer = this.clock.setTimeout(tick, active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    void tick();
    return stop;
  }

  // ---- Retirement

  /**
   * An import retires when it is over (finished, or gone from the server), no
   * command is in flight and no bridge is open. The catalog never has to move first:
   * in an idle project the final landing's own publication may be the last commit.
   * True when it retired.
   */
  private maybeRetire(record: ImportRecord, publish = true): boolean {
    if (this.records.get(record.importId) !== record) return false;
    const state = record.store.getSnapshot();
    const over = state.status?.summary.state === "finished" || record.missing;
    if (!over || record.plan || state.stop === "stopping") return false;
    const phase = state.local?.phase.kind;
    if (phase === "reading" || phase === "preparing" || phase === "uploading") return false;
    if (record.handoff.bridging) return false;
    this.retire(record, publish);
    return true;
  }

  /** End the import here for good: its record releases everything it owns. */
  private retire(record: ImportRecord, publish = true) {
    if (this.records.get(record.importId) === record) this.records.delete(record.importId);
    this.retiredIds.add(record.importId);
    record.dispose();
    if (publish) this.changed(true);
  }

  /** Whether closing the page would lose work: a run is reading, hashing, planning or sending. */
  isWorking(): boolean {
    for (const record of this.records.values()) {
      const kind = record.store.getSnapshot().local?.phase.kind;
      if (kind === "reading" || kind === "preparing" || kind === "uploading") return true;
    }
    return false;
  }

  /** End this lifetime: every answer still on its way is dropped, and every owned cache and timer reset. */
  dispose() {
    this.disposed = true;
    this.epoch += 1;
    this.watching += 1;
    this.unsubscribeCatalog?.();
    this.unsubscribeCatalog = undefined;
    if (this.openTimer) this.clock.clearTimeout(this.openTimer);
    this.openTimer = undefined;
    if (this.treeTimer) this.clock.clearTimeout(this.treeTimer);
    this.treeTimer = undefined;
    for (const record of this.records.values()) record.dispose();
    this.records.clear();
    this.retiredIds.clear();
    this.indexed = new Map();
    this.lastTreeUpdate = Number.NEGATIVE_INFINITY;
    this.snapshot = EMPTY_SNAPSHOT;
  }
}

function failureReason(cause: unknown): ImportFailureReason {
  return cause instanceof ImportRequestError && cause.status === 0
    ? "upload_failed"
    : "server_error";
}
