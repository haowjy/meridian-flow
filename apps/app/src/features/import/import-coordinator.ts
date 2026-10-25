/** Account-lifetime upload owner. Server summaries are truth; File handles stay private to this tab. */
import type { ImportDetail, ImportSelection, ImportSummary } from "@meridian/contracts";
import { importNodeId } from "@meridian/contracts";
import { ImportRequestError } from "@/client/api/imports-api";
import type { ImportDestination } from "./destination";
import type { ImportApi } from "./import-api-port";
import { buildSelection, type HeldFile } from "./manifest";
import { matchAwaiting } from "./match-awaiting";
import { type PendingRootMemory, pendingRoot } from "./pending-roots";
import { refusalSentence } from "./reason-copy";
import type { Selection } from "./selection";
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
  queue?: UploadQueue;
  read?: SelectionRead;
  destination?: ImportDestination;
  revision: number;
  creation: "local" | "uncertain" | "created";
  attempt: number;
  retiredUntil?: number;
};

export class ImportCoordinator {
  private records = new Map<string, RecordState>();
  private listeners = new Set<() => void>();
  private snapshot: ImportsSnapshot = { imports: [] };
  private timer?: ReturnType<typeof setTimeout>;
  private channel?: BroadcastChannel;
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
  private install(record: RecordState, summary: ImportSummary) {
    if (!this.current(record)) return;
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
      this.cancelUpload(record);
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
      view: { importId: summary.importId, summary, local: {} },
      controller: new AbortController(),
      held: new Map(),
      revision: 0,
      creation: "created",
      attempt: 0,
    };
  }
  start() {
    this.lifetime = new AbortController();
    this.channel = new BroadcastChannel("meridian-imports");
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
      for (const record of this.records.values()) {
        record.controller.abort();
        record.queue?.cancel();
      }
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
      const summaries = await this.api.listOpen(signal);
      if (signal.aborted || mutation !== this.mutations) return;
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
        record.controller.abort();
        record.queue?.cancel();
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
  isWorking() {
    return [...this.records.values()].some(
      (record) =>
        ["reading", "creating"].includes(record.view.local.phase ?? "") ||
        (record.queue && !record.queue.cancelled && !record.queue.idle),
    );
  }
  private cancelUpload(record: RecordState) {
    record.attempt++;
    record.queue?.cancel();
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
    void this.prepare(record);
    return importId;
  }
  private async prepare(record: RecordState) {
    try {
      const selection = await record.read!({ signal: record.controller.signal });
      if (!this.current(record)) return;
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
      if (!this.current(record)) return;
      await this.create(record);
    } catch (error) {
      if (this.current(record))
        this.local(record, {
          phase: "refused",
          error: error instanceof Error ? error.message : refusalSentence(null),
        });
    }
  }
  private async create(record: RecordState) {
    const command = record.command;
    if (!command) return;
    const previousCreation = record.creation;
    const revision = record.revision;
    record.creation = "uncertain";
    this.local(record, { phase: "creating", error: undefined });
    try {
      const summary = await this.api.create(
        record.view.summary.projectId,
        command,
        record.controller.signal,
      );
      if (!this.current(record)) return;
      this.install(record, summary);
      this.nudge();
    } catch (error) {
      if (this.current(record)) {
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
      await this.sendAwaiting(record);
    } catch (error) {
      if (this.current(record))
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
  private async sendAwaiting(record: RecordState) {
    this.cancelUpload(record);
    const detail = await this.fresh(record);
    if (detail?.state !== "uploading") return;
    const awaiting = new Set(
      detail.entries.filter((entry) => entry.state === "awaiting").map((entry) => entry.entryId),
    );
    for (const id of record.held.keys()) if (!awaiting.has(id)) record.held.delete(id);
    if (!record.held.size) {
      this.local(record, { phase: record.view.local.missing?.length ? "missing" : undefined });
      return;
    }
    const missing = record.view.local.missing;
    this.local(record, { phase: missing?.length ? "missing" : "uploading", error: undefined });
    const attempt = record.attempt;
    const current = () => this.current(record) && record.attempt === attempt;
    const sending = new Map<number, number>();
    const progress = (id: number, bytes: number) => {
      sending.set(id, bytes);
      if (current() && record.view.summary.state === "uploading")
        this.local(record, { sendingBytes: [...sending.values()].reduce((a, b) => a + b, 0) });
    };
    record.queue = new UploadQueue({
      send: async (parts, signal) => {
        // Reading here detects a file removed since picking, before the multipart request.
        const readable: (HeldFile & { bytes: ArrayBuffer })[] = [];
        const unreadable: number[] = [];
        for (const part of parts) {
          try {
            readable.push({ ...part, bytes: await part.file.arrayBuffer() });
          } catch {
            unreadable.push(part.entryId);
          }
        }
        if (!current() || signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (unreadable.length) {
          const summary = await this.api.skip(
            detail.projectId,
            detail.importId,
            { entries: unreadable.map((entryId) => ({ entryId, reason: "unreadable" })) },
            signal,
          );
          if (!current()) throw new DOMException("Aborted", "AbortError");
          if (
            record.view.summary.state === "uploading" &&
            summary.counts.received >= record.view.summary.counts.received
          )
            this.install(record, summary);
          for (const id of unreadable) record.held.delete(id);
        }
        if (!readable.length) return { entries: [] };
        try {
          const answer = await this.api.send(
            detail.projectId,
            detail.importId,
            readable.map((part) => ({
              entryId: part.entryId,
              file: new Blob([part.bytes], { type: part.file.type }),
              name: part.file.name,
              changed: part.changed,
            })),
            signal,
            (bytes) => progress(parts[0].entryId, bytes),
          );
          // Concurrent receives may answer out of order; never regress a receipt count or a later phase.
          if (
            current() &&
            record.view.summary.state === "uploading" &&
            answer.summary.counts.received >= record.view.summary.counts.received
          )
            this.install(record, answer.summary);
          return answer;
        } finally {
          progress(parts[0].entryId, 0);
        }
      },
      onOutcome: (outcomes) => {
        if (!current()) return;
        for (const outcome of outcomes)
          if (outcome.kind === "answered" && outcome.entry.state !== "awaiting")
            record.held.delete(outcome.entry.entryId);
      },
      onIdle: () => {
        if (current())
          this.local(record, {
            phase: missing?.length ? "missing" : record.held.size ? "stalled" : undefined,
          });
      },
    });
    record.queue.add([...record.held.values()]);
  }
  async continue(id: string, selection: Selection) {
    const record = this.records.get(id);
    if (!record) return;
    await this.command(record, async () => {
      this.cancelUpload(record);
      const detail = await this.fresh(record);
      if (detail?.state !== "uploading") return;
      const match = matchAwaiting(detail, selection);
      record.held = match.held;
      if (match.wrongRoot) this.local(record, { phase: "wrong-root" });
      else {
        this.local(record, {
          missing: match.missing,
          phase: match.missing.length ? "missing" : undefined,
        });
        await this.sendAwaiting(record);
      }
    });
  }
  async withoutMissing(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    await this.command(record, async () => {
      this.cancelUpload(record);
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
          record.controller.signal,
        ),
      );
      this.local(record, { missing: undefined });
      await this.sendAwaiting(record);
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
      this.cancelUpload(record);
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
      record.controller.abort();
      record.queue?.cancel();
      this.records.delete(id);
      this.publish();
      this.nudge();
    });
  }
  async retry(id: string) {
    const record = this.records.get(id);
    if (!record) return;
    await this.command(record, async () => {
      if (record.creation !== "created") {
        if (record.command) await this.create(record);
        else await this.prepare(record);
      } else if (record.view.summary.state === "failed")
        this.install(
          record,
          await this.api.retry(record.view.summary.projectId, id, record.controller.signal),
        );
      else await this.sendAwaiting(record);
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
