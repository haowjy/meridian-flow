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
  private pending: HeldFile[] = [];
  private readonly busy = new Set<number>();
  private workers = 0;

  constructor(
    private readonly options: {
      signal: AbortSignal;
      send: SendFiles;
      onOutcome: (outcomes: UploadOutcome[]) => void;
      gate?: Promise<boolean>;
      onIdle: () => void;
    },
  ) {}

  private get cancelled(): boolean {
    return this.options.signal.aborted;
  }

  add(files: readonly HeldFile[]): number {
    if (this.cancelled) return 0;
    let added = 0;
    for (const file of files) {
      if (this.busy.has(file.entryId)) continue;
      this.busy.add(file.entryId);
      this.pending.push(file);
      added += 1;
    }
    while (
      !this.cancelled &&
      this.workers < IMPORT_SCHEDULING.concurrentRequests &&
      this.pending.length > 0
    ) {
      this.workers += 1;
      void this.work();
    }
    return added;
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
        const gate = this.pending.length === 0 ? this.options.gate : undefined;
        if (!gate || (await gate)) await this.sendBatch(parts);
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
      const answer = await sendWithBackoff(this.options.send, parts, this.options.signal);
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
