/**
 * JSONL dev EventSink: appends one JSON object per line under a configurable
 * directory (`logs/YYYY-MM-DD.jsonl` by default). Safe under concurrent emits
 * from a single process via a serialized write chain.
 */
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { EventRecord, EventSink } from "../../ports/event-sink.js";

export type JsonlEventSinkOptions = {
  /** Directory for daily JSONL files; created on first emit if missing. */
  dir: string;
  /** Injectable clock for tests and deterministic filenames. */
  now?: () => Date;
};

function utcDateStamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class JsonlEventSink implements EventSink {
  private readonly dir: string;
  private readonly now: () => Date;
  private writeChain: Promise<void> = Promise.resolve();
  private activeDate: string | null = null;
  private activePath: string | null = null;

  constructor(options: JsonlEventSinkOptions) {
    this.dir = options.dir;
    this.now = options.now ?? (() => new Date());
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
    const filePath = await this.resolveFilePath();
    const payload = events.map((event) => `${JSON.stringify(event)}\n`).join("");
    await appendFile(filePath, payload, { encoding: "utf8", flag: "a" });
  }

  private async resolveFilePath(): Promise<string> {
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

export function createJsonlEventSink(options: JsonlEventSinkOptions): EventSink {
  return new JsonlEventSink(options);
}
