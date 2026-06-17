/**
 * Local EventSink: always writes structured JSON events to stdout for platform
 * log capture and optionally mirrors them to `LOG_DIR/YYYY-MM-DD.jsonl` when a
 * log directory is configured. Writes are serialized per process.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { EventRecord, EventSink } from "../../ports/event-sink.js";
import { sanitizeEventRecord } from "../../safe-event.js";

export type LocalEventSinkOptions = {
  /** Optional directory for daily JSONL files; omitted means stdout-only. */
  dir?: string;
  /** Injectable clock for tests and deterministic filenames. */
  now?: () => Date;
  /** Injectable output stream for tests; defaults to process stdout. */
  stdout?: Pick<NodeJS.WriteStream, "write">;
};

function utcDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class LocalEventSink implements EventSink {
  private readonly dir: string | undefined;
  private readonly now: () => Date;
  private readonly stdout: Pick<NodeJS.WriteStream, "write">;
  private writeChain: Promise<void> = Promise.resolve();
  private activeDate: string | null = null;
  private activePath: string | null = null;

  constructor(options: LocalEventSinkOptions = {}) {
    this.dir = options.dir;
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
    this.writeChain = this.writeChain.then(() => this.appendEvents(events));
  }

  private async appendEvents(events: EventRecord[]): Promise<void> {
    const payload = events
      .map((event) => `${JSON.stringify(sanitizeEventRecord(event))}\n`)
      .join("");
    this.stdout.write(payload);
    const filePath = await this.resolveFilePath();
    if (!filePath) return;
    await appendFile(filePath, payload, { encoding: "utf8", flag: "a" });
  }

  private async resolveFilePath(): Promise<string | null> {
    if (!this.dir) return null;
    const date = utcDateStamp(this.now());
    if (this.activeDate === date && this.activePath) {
      return this.activePath;
    }

    await mkdir(this.dir, { recursive: true });
    const filePath = path.join(this.dir, `${date}.jsonl`);
    this.activeDate = date;
    this.activePath = filePath;
    return filePath;
  }
}

export function createLocalEventSink(options: LocalEventSinkOptions = {}): EventSink {
  return new LocalEventSink(options);
}
