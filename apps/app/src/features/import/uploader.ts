/**
 * Sends the files still outstanding, in batches, a few requests at a time.
 * A failed batch is retried one file at a time so a single bad file fails
 * alone and the rest land.
 */
import type { ImportEntryReport } from "@meridian/contracts";
import { planBatches } from "./batching";
import { IMPORT_FILE_LIMITS } from "./limits";
import type { HeldFile } from "./manifest";

export type SendFiles = (
  parts: readonly HeldFile[],
  signal: AbortSignal,
) => Promise<{ entries: ImportEntryReport[] }>;

export type UploadOutcome =
  | { kind: "answered"; entry: ImportEntryReport }
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

export async function uploadFiles(options: {
  files: readonly HeldFile[];
  send: SendFiles;
  signal: AbortSignal;
  onOutcome: (outcomes: UploadOutcome[]) => void;
}): Promise<void> {
  const byId = new Map(options.files.map((file) => [file.entryId, file]));
  const batches = planBatches(
    options.files.map((file) => ({ entryId: file.entryId, size: file.file.size })),
  );
  let next = 0;
  async function sendBatch(parts: readonly HeldFile[]): Promise<void> {
    try {
      const answer = await sendWithBackoff(options.send, parts, options.signal);
      options.onOutcome(answer.entries.map((entry) => ({ kind: "answered", entry })));
    } catch (cause) {
      if (cause instanceof UploadAborted) throw cause;
      if (parts.length > 1) {
        for (const part of parts) await sendBatch([part]);
        return;
      }
      options.onOutcome([{ kind: "failed", entryId: parts[0].entryId, cause }]);
    }
  }
  async function worker() {
    while (next < batches.length) {
      if (options.signal.aborted) return;
      const batch = batches[next++];
      const parts = batch.flatMap((item) => byId.get(item.entryId) ?? []);
      await sendBatch(parts);
    }
  }
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(IMPORT_FILE_LIMITS.concurrentRequests, batches.length) },
        worker,
      ),
    );
  } catch (error) {
    if (!(error instanceof UploadAborted)) throw error;
  }
}
