/** Account-lifetime upload owner. Server summaries are truth; File handles stay private to this tab. */
import type { ImportDetail, ImportSelection, ImportSummary } from "@meridian/contracts";
import { importNodeId } from "@meridian/contracts";
import { ImportRequestError } from "@/client/api/imports-api";
import type { ImportDestination } from "./destination";
import { hashPicked } from "./hash-picked";
import type { ImportApi } from "./import-api-port";
import { probeReadable } from "./local-read";
import { buildSelection, type HeldFile } from "./manifest";
import { matchContinue, type PickedReceived } from "./match-continue";
import { type PendingRootMemory, pendingRoot } from "./pending-roots";
import { refusalSentence } from "./reason-copy";
import type { Selection } from "./selection";
import { UploadAttempt } from "./upload-attempt";
import { UploadPresence } from "./upload-presence";
import { UploadQueue } from "./uploader";

export type SelectionRead = (options: { signal: AbortSignal }) => Promise<Selection>;
export type LocalUpload = {
  phase?: "reading" | "creating" | "uploading" | "stalled" | "missing" | "wrong-root" | "refused";
  missing?: number[];
  sendingBytes?: number;
  error?: string;
  stopAsked?: boolean;
  busy?: boolean;
  stopLost?: boolean;
  /** Another tab holds this import's upload lock: it is sending the files this tab lacks. Set only by `publish`. */
  elsewhere?: boolean;
};
export type TrackedImport = {
  importId: string;
  summary: ImportSummary;
  local: LocalUpload;
  detail?: ImportDetail;
  dismissed?: boolean;
};
export type ImportsSnapshot = { imports: readonly TrackedImport[] };
type RecordState = {
  view: TrackedImport;
  controller: AbortController;
  held: Map<number, HeldFile>;
  command?: ImportSelection;
  read?: SelectionRead;
  destination?: ImportDestination;
  revision: number;
  creation: "local" | "uncertain" | "created";
  /** The tab's current work on this import; it holds the import's presence lock until it ends. */
  attempt?: UploadAttempt;
  retiredUntil?: number;
  /** Re-picked received files still owed a hash report. Kept when the report fails, so Retry repeats it. */
  picked: PickedReceived[];
};

export class ImportCoordinator {
  private records = new Map<string, RecordState>();
  private listeners = new Set<() => void>();
  private snapshot: ImportsSnapshot = { imports: [] };
  private timer?: ReturnType<typeof setTimeout>;
  private channel?: BroadcastChannel;
  private presence = new UploadPresence(() => this.channel?.postMessage(null));
  /** Import ids whose upload lock another tab held at the last refresh. */
  private others = new Set<string>();
  private lifetime = new AbortController();
  private polling: AbortSignal | null = null;
  private mutations = 0;
  private rootMemory = new Map<string, PendingRootMemory>();
  observeRoot(summary: ImportSummary, catalogHolds: boolean, reading: boolean) {
    const result = pendingRoot(
      summary,
      this.rootMemory.get(summary.importId) ?? { seen: false, drawn: false },
      catalogHolds,
      Date.now(),
      reading,
    );
    this.rootMemory.set(summary.importId, result.memory);
    return result.draw;
  }
  constructor(private readonly api: ImportApi) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private publish() {
    for (const record of this.records.values()) {
      const { importId, local } = record.view;
      const elsewhere = this.others.has(importId) && !this.presence.holds(importId);
      if (!!local.elsewhere !== elsewhere)
        record.view = { ...record.view, local: { ...local, elsewhere } };
    }
    this.snapshot = { imports: [...this.records.values()].map((record) => record.view) };
    for (const listener of this.listeners) listener();
  }
  private local(record: RecordState, patch: Partial<LocalUpload>) {
    record.view = { ...record.view, local: { ...record.view.local, ...patch } };
    this.publish();
  }
  private current(record: RecordState) {
    return !record.controller.signal.aborted && this.records.get(record.view.importId) === record;
  }
  private live(record: RecordState, attempt: UploadAttempt) {
    return !attempt.ended && this.current(record);
  }
  /** Start the record's next attempt. Its lease is requested before the one it replaces is released, so presence never lapses between them. */
  private open(record: RecordState) {
    const attempt = new UploadAttempt(this.presence.hold(record.view.importId));
    record.attempt?.end();
    record.attempt = attempt;
    return attempt;
  }
  /** Run work as the record's next attempt; the attempt ends with the work unless it handed some off. */
  private async run(record: RecordState, body: (attempt: UploadAttempt) => Promise<void>) {
    const attempt = this.open(record);
    try {
      await body(attempt);
    } finally {
      attempt.release();
    }
  }
  private retire(record: RecordState) {
    record.controller.abort();
    record.attempt?.end();
  }
  private install(record: RecordState, summary: ImportSummary) {
    if (!this.current(record)) return;
    // Concurrent answers can arrive out of order: an uploading summary never replaces a later
    // state, and receipts only accumulate.
    if (
      summary.state === "uploading" &&
      (record.view.summary.state !== "uploading" ||
        summary.counts.received < record.view.summary.counts.received)
    )
      return;
    record.revision++;
    record.creation = "created";
    const memory = this.rootMemory.get(summary.importId);
    if (summary.root?.created && memory?.drawn && memory.deadline === undefined)
      this.rootMemory.set(summary.importId, { ...memory, deadline: Date.now() + 30000 });
    const doneUpload = summary.state !== "uploading";
    if (record.view.local.phase === "refused")
      record.view = { ...record.view, local: { ...record.view.local, phase: "stalled" } };
    if (doneUpload) {
      record.held.clear();
      record.picked = [];
      record.attempt?.end();
    }
    record.view = {
      ...record.view,
      summary,
      local: doneUpload
        ? { ...record.view.local, phase: undefined, missing: undefined, sendingBytes: undefined }
        : record.view.local,
    };
    this.publish();
  }
  private make(summary: ImportSummary): RecordState {
    return {
      view: {
        importId: summary.importId,
        summary,
        local: {},
      },
      controller: new AbortController(),
      held: new Map(),
      revision: 0,
      creation: "created",
      picked: [],
    };
  }
  start() {
    this.lifetime = new AbortController();
    this.channel = new BroadcastChannel("meridian-imports");
    // A message only says some tab's state changed; the lock table and server are the truth.
    this.channel.onmessage = () => {
      void this.refresh();
    };
    const focus = () => {
      void this.refresh();
    };
    window.addEventListener("focus", focus);
    void this.refresh();
    return () => {
      this.lifetime.abort();
      clearTimeout(this.timer);
      this.channel?.close();
      this.channel = undefined;
      window.removeEventListener("focus", focus);
      for (const record of this.records.values()) this.retire(record);
      this.records.clear();
      this.publish();
    };
  }
  private nudge() {
    this.mutations++;
    this.channel?.postMessage(null);
    void this.refresh();
  }
  async refresh() {
    if (this.polling === this.lifetime.signal || this.lifetime.signal.aborted) return;
    const signal = this.lifetime.signal;
    this.polling = signal;
    const mutation = this.mutations;
    const revisions = new Map([...this.records].map(([id, record]) => [id, record.revision]));
    try {
      const [summaries, others] = await Promise.all([
        this.api.listOpen(signal),
        this.presence.othersHolding(),
      ]);
      if (signal.aborted || mutation !== this.mutations) return;
      this.others = others;
      const ids = new Set(summaries.map((summary) => summary.importId));
      for (const summary of summaries) {
        const record = this.records.get(summary.importId);
        if (record?.view.dismissed) continue;
        if (!record) this.records.set(summary.importId, this.make(summary));
        else if (
          record.revision === revisions.get(summary.importId) &&
          !record.view.local.busy &&
          record.view.local.phase !== "reading" &&
          record.view.local.phase !== "creating"
        )
          this.install(record, summary);
      }
      for (const [id, record] of this.records) {
        if (
          ids.has(id) ||
          record.creation !== "created" ||
          record.revision !== revisions.get(id) ||
          record.view.local.phase === "reading" ||
          record.view.local.phase === "creating" ||
          record.view.local.phase === "refused"
        )
          continue;
        if (record.view.summary.root?.created) {
          record.retiredUntil ??= Date.now() + 30000;
          record.view = { ...record.view, dismissed: true };
          if (Date.now() < record.retiredUntil) continue;
        }
        this.retire(record);
        this.records.delete(id);
      }
      this.publish();
    } catch {
      /* A failed background read cannot erase the last durable summary. */
    } finally {
      if (this.polling === signal) this.polling = null;
      if (!signal.aborted) {
        clearTimeout(this.timer);
        const active = [...this.records.values()].some(
          ({ view }) =>
            view.summary.state === "organizing" ||
            view.summary.state === "uploading" ||
            view.dismissed === true,
        );
        this.timer = setTimeout(
          () => {
            void this.refresh();
          },
          active ? 2000 : 30000,
        );
      }
    }
  }
  /** This tab is reading, creating, sending or hashing files of some import. */
  isWorking() {
    return this.presence.working;
  }
  begin(
    projectId: string,
    destination: ImportDestination,
    label: string,
    read: SelectionRead,
    rootName?: string,
  ) {
    const importId = crypto.randomUUID();
    const record = this.make({
      importId,
      projectId,
      state: "uploading",
      label: { kind: rootName ? "folder" : "files", name: label, count: 0 },
      destination: { folderUri: destination.uri, folderId: destination.folderId, fellBack: false },
      root: rootName
        ? {
            id: importNodeId({ projectId, importId, rootId: 0, kind: "folder", path: "" }),
            name: rootName,
            created: false,
          }
        : null,
      counts: {
        files: 0,
        bytes: 0,
        received: 0,
        receivedBytes: 0,
        prepared: 0,
        organized: 0,
        skipped: 0,
        failed: 0,
        needsLook: 0,
      },
      waiting: false,
      lastActivityAt: new Date().toISOString(),
      reason: null,
    });
    record.creation = "local";
    record.read = read;
    record.destination = destination;
    record.view.local.phase = "reading";
    this.records.set(importId, record);
    this.publish();
    void this.run(record, (attempt) => this.prepare(record, attempt));
    return importId;
  }
  private async prepare(record: RecordState, attempt: UploadAttempt) {
    try {
      const selection = await record.read!({ signal: attempt.signal });
      if (!this.live(record, attempt)) return;
      const { command, held } = buildSelection(
        selection,
        record.view.importId,
        record.destination!.uri,
      );
      record.command = command;
      record.held = held;
      const root =
        command.roots.length === 1 &&
        command.roots[0].kind === "folder" &&
        !command.roots[0].meridianExport
          ? command.roots[0]
          : null;
      record.view = {
        ...record.view,
        summary: {
          ...record.view.summary,
          root: root
            ? {
                id: importNodeId({
                  projectId: record.view.summary.projectId,
                  importId: command.importId,
                  rootId: root.rootId,
                  path: "",
                  kind: "folder",
                }),
                name: root.name,
                created: false,
              }
            : null,
        },
      };
      if (!this.live(record, attempt)) return;
      await this.create(record, attempt);
    } catch (error) {
      if (this.live(record, attempt))
        this.local(record, {
          phase: "refused",
          error: error instanceof Error ? error.message : refusalSentence(null),
        });
    }
  }
  private async create(record: RecordState, attempt: UploadAttempt) {
    const command = record.command;
    if (!command) return;
    const previousCreation = record.creation;
    const revision = record.revision;
    record.creation = "uncertain";
    this.local(record, { phase: "creating", error: undefined });
    try {
      const summary = await this.api.create(record.view.summary.projectId, command, attempt.signal);
      if (!this.live(record, attempt)) return;
      this.install(record, summary);
      this.nudge();
    } catch (error) {
      if (this.live(record, attempt)) {
        // A refused replay cannot disprove an earlier unanswered create.
        if (
          previousCreation === "local" &&
          record.revision === revision &&
          error instanceof ImportRequestError &&
          error.status >= 400 &&
          error.status < 500
        )
          record.creation = "local";
        this.local(record, {
          phase: record.creation === "local" ? "refused" : "stalled",
          error: refusalSentence(error instanceof ImportRequestError ? error.code : null),
        });
      }
      return;
    }
    try {
      await this.sendAwaiting(record, attempt);
    } catch (error) {
      if (this.live(record, attempt))
        this.local(record, {
          phase: "stalled",
          error: refusalSentence(error instanceof ImportRequestError ? error.code : null),
        });
    }
  }
  private async fresh(record: RecordState): Promise<ImportDetail | null> {
    while (this.current(record)) {
      const revision = record.revision;
      const detail = await this.api.detail(
        record.view.summary.projectId,
        record.view.importId,
        record.controller.signal,
      );
      if (!this.current(record)) return null;
      // Required reads retry if a newer authoritative answer won while they travelled.
      if (revision !== record.revision) continue;
      this.install(record, detail);
      record.view = { ...record.view, detail };
      this.publish();
      return detail;
    }
    return null;
  }
  async loadDetail(id: string) {
    const record = this.records.get(id);
    if (record)
      await this.command(record, async () => {
        await this.fresh(record);
      });
  }
  private async command(record: RecordState, run: () => Promise<void>) {
    if (record.view.local.busy) return;
    this.local(record, { busy: true, error: undefined });
    try {
      await run();
    } catch (error) {
      if (this.current(record))
        this.local(record, {
          error: refusalSentence(error instanceof ImportRequestError ? error.code : null),
          ...(record.view.summary.state === "uploading" && record.held.size
            ? { phase: "stalled" as const }
            : {}),
        });
    } finally {
      if (this.current(record)) this.local(record, { busy: false });
    }
  }
  /**
   * Hash the re-picked received files and tell the server which receipts they match. The server
   * takes the report only while the import is uploading, so whatever can end the upload waits for
   * it. Resolves true once nothing is owed. A failure keeps the report owed and shows its error,
   * for Retry to repeat; a refusal drops it, since the marks are advisory.
   */
  private report(record: RecordState, attempt: UploadAttempt): Promise<boolean> {
    attempt.reporting ??= this.sendReport(record, attempt);
    return attempt.reporting;
  }
  private async sendReport(record: RecordState, attempt: UploadAttempt) {
    const entries = await hashPicked(record.picked, attempt.signal);
    if (!this.live(record, attempt)) return false;
    try {
      if (entries.length)
        this.install(
          record,
          await this.api.picked(
            record.view.summary.projectId,
            record.view.importId,
            { entries },
            attempt.signal,
          ),
        );
    } catch (error) {
      if (!this.live(record, attempt)) return false;
      if (!(error instanceof ImportRequestError && error.status >= 400 && error.status < 500)) {
        this.local(record, {
          error: refusalSentence(error instanceof ImportRequestError ? error.code : null),
        });
        return false;
      }
    }
    record.picked = [];
    return true;
  }
  private async sendAwaiting(record: RecordState, attempt: UploadAttempt) {
    const detail = await this.fresh(record);
    if (detail?.state !== "uploading" || attempt.ended) return;
    const awaiting = new Set(
      detail.entries.filter((entry) => entry.state === "awaiting").map((entry) => entry.entryId),
    );
    for (const id of record.held.keys()) if (!awaiting.has(id)) record.held.delete(id);
    const owed = record.picked.length > 0;
    const missing = record.view.local.missing;
    if (!record.held.size && !owed) {
      this.local(record, { phase: missing?.length ? "missing" : undefined });
      return;
    }
    this.local(record, { phase: missing?.length ? "missing" : "uploading", error: undefined });
    const live = () => this.live(record, attempt);
    const reported = owed ? this.report(record, attempt) : undefined;
    let drained!: () => void;
    const sent = new Promise<void>((resolve) => {
      drained = resolve;
    });
    const queue = new UploadQueue({
      signal: attempt.signal,
      gate: reported,
      send: async (parts, signal) => {
        // A one-byte read detects a file removed since picking, before the multipart request;
        // the request then streams the file itself instead of a copy of the batch in memory.
        const probes = await Promise.all(
          parts.map((part) =>
            probeReadable(part.file).then(
              () => true,
              () => false,
            ),
          ),
        );
        const readable = parts.filter((_, index) => probes[index]);
        const unreadable = parts.filter((_, index) => !probes[index]).map((part) => part.entryId);
        if (!live() || signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (unreadable.length) {
          const summary = await this.api.skip(
            detail.projectId,
            detail.importId,
            { entries: unreadable.map((entryId) => ({ entryId, reason: "unreadable" })) },
            signal,
          );
          if (!live()) throw new DOMException("Aborted", "AbortError");
          this.install(record, summary);
          for (const id of unreadable) record.held.delete(id);
        }
        if (!readable.length) return { entries: [] };
        const progress = (bytes: number) => {
          const total = attempt.progress(parts[0].entryId, bytes);
          if (live() && record.view.summary.state === "uploading")
            this.local(record, { sendingBytes: total });
        };
        try {
          const answer = await this.api.send(
            detail.projectId,
            detail.importId,
            readable.map((part) => ({
              entryId: part.entryId,
              file: part.file,
              name: part.file.name,
              changed: part.changed,
            })),
            signal,
            progress,
          );
          if (live()) this.install(record, answer.summary);
          return answer;
        } finally {
          progress(0);
        }
      },
      onOutcome: (outcomes) => {
        if (!live()) return;
        for (const outcome of outcomes)
          if (outcome.kind === "answered" && outcome.entry.state !== "awaiting")
            record.held.delete(outcome.entry.entryId);
      },
      onIdle: drained,
    });
    if (record.held.size) queue.add([...record.held.values()]);
    else drained();
    attempt.holdUntil(
      Promise.all([sent, reported]).then(() => {
        if (live())
          this.local(record, {
            phase: missing?.length
              ? "missing"
              : record.held.size || record.picked.length
                ? "stalled"
                : undefined,
          });
      }),
    );
  }
  async continue(id: string, selection: Selection) {
    const record = this.records.get(id);
    if (!record) return;
    await this.command(record, () =>
      this.run(record, async (attempt) => {
        const detail = await this.fresh(record);
        if (detail?.state !== "uploading") return;
        const match = matchContinue(detail, selection);
        record.held = match.held;
        record.picked = match.received;
        if (match.wrongRoot) {
          this.local(record, { phase: "wrong-root" });
          return;
        }
        this.local(record, {
          missing: match.missing,
          phase: match.missing.length ? "missing" : undefined,
        });
        await this.sendAwaiting(record, attempt);
      }),
    );
  }
  async withoutMissing(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    await this.command(record, async () => {
      // The skip can end the upload, so the hash report it would pre-empt goes first.
      await record.attempt?.reporting;
      await this.run(record, async (attempt) => {
        if (record.picked.length && !(await this.report(record, attempt))) return;
        this.install(
          record,
          await this.api.skip(
            record.view.summary.projectId,
            id,
            {
              entries: (record.view.local.missing ?? []).map((entryId) => ({
                entryId,
                reason: "not_found",
              })),
            },
            attempt.signal,
          ),
        );
        this.local(record, { missing: undefined });
        await this.sendAwaiting(record, attempt);
      });
    });
  }
  askStop(id: string, stopAsked: boolean) {
    const record = this.records.get(id);
    if (record) this.local(record, { stopAsked });
  }
  async stop(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    await this.command(record, async () => {
      record.attempt?.end();
      const refused = record.creation === "local" && record.view.local.phase === "refused";
      if (record.command && !refused) {
        // A lost create answer may already have created the import. Replay before stopping it.
        if (record.creation !== "created")
          await this.api.create(
            record.view.summary.projectId,
            record.command,
            record.controller.signal,
          );
      }
      if (!refused && (record.command || !record.read)) {
        try {
          await this.api.stop(record.view.summary.projectId, id, record.controller.signal);
        } catch (error) {
          if (!(error instanceof ImportRequestError) || error.code !== "import_finished")
            throw error;
          this.local(record, { stopAsked: false, stopLost: true });
          await this.fresh(record);
          return;
        }
      }
      this.retire(record);
      this.records.delete(id);
      this.publish();
      this.nudge();
    });
  }
  async retry(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    await this.command(record, async () => {
      if (record.creation === "created" && record.view.summary.state === "failed")
        this.install(
          record,
          await this.api.retry(record.view.summary.projectId, id, record.controller.signal),
        );
      else
        await this.run(record, (attempt) =>
          record.creation !== "created"
            ? record.command
              ? this.create(record, attempt)
              : this.prepare(record, attempt)
            : this.sendAwaiting(record, attempt),
        );
      this.nudge();
    });
  }
  async acknowledge(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    await this.command(record, async () => {
      if (record.creation !== "local")
        await this.api.acknowledge(record.view.summary.projectId, id, record.controller.signal);
      if (record.view.summary.root?.created) {
        record.retiredUntil = Date.now() + 30000;
        record.view = { ...record.view, dismissed: true };
      } else this.records.delete(id);
      this.publish();
      this.nudge();
    });
  }
}
