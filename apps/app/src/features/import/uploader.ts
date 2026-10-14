/**
 * One import's sends: a queue of files, batched, a few requests at a time. Retry
 * adds to the same queue, so retries share the import's request budget and a
 * file already queued or in flight is never sent twice. A failed batch is retried
 * one file at a time so a single bad file fails alone and the rest land.
 */
import type { ImportFilesResult } from "@meridian/contracts";
import { planBatches } from "./batching";
import { IMPORT_SCHEDULING } from "./limits";
import type { HeldFile } from "./manifest";

export type SendFiles = (
  parts: readonly HeldFile[],
  signal: AbortSignal,
) => Promise<Pick<ImportFilesResult, "entries">>;

export type UploadOutcome =
  | { kind: "answered"; entry: ImportFilesResult["entries"][number] }
  | { kind: "failed"; entryId: number; cause: unknown };

const BUSY_BACKOFF_MS = [400, 1000, 2500];

export class UploadAborted extends Error {
  constructor() {
    super("Upload stopped");
  }
}

function isBusy(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    (error as { status: unknown }).status === 429
  );
}

async function sendWithBackoff(send: SendFiles, parts: readonly HeldFile[], signal: AbortSignal) {
  for (let attempt = 0; ; attempt += 1) {
    if (signal.aborted) throw new UploadAborted();
    try {
      return await send(parts, signal);
    } catch (error) {
      if (signal.aborted) throw new UploadAborted();
      if (!isBusy(error) || attempt >= BUSY_BACKOFF_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, BUSY_BACKOFF_MS[attempt]));
    }
  }
}

export class UploadQueue {
  private readonly controller = new AbortController();
  private pending: HeldFile[] = [];
  /** Entry ids queued or in flight. */
  private readonly busy = new Set<number>();
  private workers = 0;

  constructor(
    private readonly options: {
      send: SendFiles;
      onOutcome: (outcomes: UploadOutcome[]) => void;
      /** Every queued file has an answer or a failure; not called after `cancel`. */
      onIdle: () => void;
    },
  ) {}

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  get idle(): boolean {
    return this.workers === 0;
  }

  /** Queue files to send. Returns how many were not already queued or in flight. */
  add(files: readonly HeldFile[]): number {
    if (this.cancelled) return 0;
    let added = 0;
    for (const file of files) {
      if (this.busy.has(file.entryId)) continue;
      this.busy.add(file.entryId);
      this.pending.push(file);
      added += 1;
    }
    while (this.workers < IMPORT_SCHEDULING.concurrentRequests && this.pending.length > 0) {
      this.workers += 1;
      void this.work();
    }
    return added;
  }

  /** Abort every request in flight and send nothing more. */
  cancel() {
    this.controller.abort();
    this.pending = [];
  }

  private takeBatch(): HeldFile[] {
    const [batch = []] = planBatches(
      this.pending.map((file) => ({ entryId: file.entryId, size: file.file.size })),
    );
    const ids = new Set(batch.map((item) => item.entryId));
    const taken = this.pending.filter((file) => ids.has(file.entryId));
    this.pending = this.pending.filter((file) => !ids.has(file.entryId));
    return taken;
  }

  private async work() {
    try {
      while (this.pending.length > 0 && !this.cancelled) {
        const parts = this.takeBatch();
        await this.sendBatch(parts);
        for (const part of parts) this.busy.delete(part.entryId);
      }
    } catch (error) {
      if (!(error instanceof UploadAborted)) throw error;
    } finally {
      this.workers -= 1;
      if (this.workers === 0 && !this.cancelled) this.options.onIdle();
    }
  }

  private async sendBatch(parts: readonly HeldFile[]): Promise<void> {
    try {
      const answer = await sendWithBackoff(this.options.send, parts, this.controller.signal);
      this.options.onOutcome(answer.entries.map((entry) => ({ kind: "answered", entry })));
    } catch (cause) {
      if (cause instanceof UploadAborted) throw cause;
      if (parts.length > 1) {
        for (const part of parts) await this.sendBatch([part]);
        return;
      }
      this.options.onOutcome([{ kind: "failed", entryId: parts[0].entryId, cause }]);
    }
  }
}
