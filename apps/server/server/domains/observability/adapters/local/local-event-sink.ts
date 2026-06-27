/**
 * Local EventSink: always writes structured JSON events to stdout for platform
 * log capture and optionally mirrors them to `LOG_DIR/YYYY-MM-DD.jsonl` when a
 * log directory is configured. Daily files can be retained for a bounded number
 * of days. Writes are serialized per process.
 */
import { appendFile, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { EventRecord, EventSink } from "../../ports/event-sink.js";
import { sanitizeEventRecord } from "../../safe-event.js";

export type LocalEventSinkOptions = {
  /** Optional directory for daily JSONL files; omitted means stdout-only. */
  dir?: string;
  /** Optional number of UTC daily JSONL files to retain, including today's file. */
  retentionDays?: number;
  /** Injectable clock for tests and deterministic filenames. */
  now?: () => Date;
  /** Injectable output stream for tests; defaults to process stdout. */
  stdout?: Pick<NodeJS.WriteStream, "write">;
};

const DAILY_LOG_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function utcDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function cutoffDateStamp(now: Date, retentionDays: number): string {
  const cutoff = new Date(now);
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(0, retentionDays - 1));
  return utcDateStamp(cutoff);
}

export class LocalEventSink implements EventSink {
  private readonly dir: string | undefined;
  private readonly retentionDays: number | undefined;
  private readonly now: () => Date;
  private readonly stdout: Pick<NodeJS.WriteStream, "write">;
  private writeChain: Promise<void> = Promise.resolve();
  private activeDate: string | null = null;
  private activePath: string | null = null;

  constructor(options: LocalEventSinkOptions = {}) {
    this.dir = options.dir;
    this.retentionDays = options.retentionDays;
    this.now = options.now ?? (() => new Date());
    this.stdout = options.stdout ?? process.stdout;
  }

  emit(event: EventRecord): void {
    this.enqueue([event]);
  }

  emitBatch(events: EventRecord[]): void {
    if (events.length === 0) return;
    this.enqueue(events);
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** Resolved path for the active daily file — test hook for reading back lines. */
  currentFilePath(): string | null {
    return this.activePath;
  }

  private enqueue(events: EventRecord[]): void {
    this.writeChain = this.writeChain.catch(() => undefined).then(() => this.appendEvents(events));
  }

  private async appendEvents(events: EventRecord[]): Promise<void> {
    const payload = events
      .map((event) => `${JSON.stringify(sanitizeEventRecord(event))}\n`)
      .join("");
    this.stdout.write(payload);
    if (!this.dir) return;
    try {
      const filePath = await this.resolveFilePath();
      if (filePath) await appendFile(filePath, payload, { encoding: "utf8", flag: "a" });
    } catch {
      // Stdout is the required local sink; JSONL mirroring is best-effort.
    }
  }

  private async resolveFilePath(): Promise<string | null> {
    if (!this.dir) return null;
    const now = this.now();
    const date = utcDateStamp(now);
    if (this.activeDate === date && this.activePath) {
      return this.activePath;
    }

    await mkdir(this.dir, { recursive: true });
    await this.pruneExpiredFiles(now);
    const filePath = path.join(this.dir, `${date}.jsonl`);
    this.activeDate = date;
    this.activePath = filePath;
    return filePath;
  }

  private async pruneExpiredFiles(now: Date): Promise<void> {
    if (!this.dir || this.retentionDays === undefined) return;
    const cutoff = cutoffDateStamp(now, this.retentionDays);
    const entries = await readdir(this.dir, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && DAILY_LOG_FILE_PATTERN.test(entry.name))
        .filter((entry) => entry.name.slice(0, 10) < cutoff)
        .map((entry) => unlink(path.join(this.dir as string, entry.name))),
    );
  }
}

export function createLocalEventSink(options: LocalEventSinkOptions = {}): EventSink {
  return new LocalEventSink(options);
}
