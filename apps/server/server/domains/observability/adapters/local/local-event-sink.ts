/**
 * Local EventSink: always writes structured JSON events to stdout for platform
 * log capture and optionally mirrors them to `LOG_DIR/YYYY-MM-DD.jsonl` when a
 * log directory is configured. Daily files can be retained for a bounded number
 * of days. Writes are serialized per process.
 */
import { appendFile as appendFileToDisk, mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { EventRecord, EventSink } from "../../ports/event-sink.js";
import { sanitizeEventRecord } from "../../safe-event.js";

type EventOutput = {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
};

export type LocalEventSinkOptions = {
  /** Optional directory for daily JSONL files; omitted means stdout-only. */
  dir?: string;
  /** Optional number of UTC daily JSONL files to retain, including today's file. */
  retentionDays?: number;
  /** Injectable clock for tests and deterministic filenames. */
  now?: () => Date;
  /** Injectable output stream for tests; defaults to process stdout. */
  stdout?: EventOutput;
  /** Injectable JSONL writer for deterministic backpressure tests. */
  appendFile?: typeof appendFileToDisk;
  /** Maximum number of events waiting behind the active write. */
  pendingEventCapacity?: number;
};

const DAILY_LOG_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const DEFAULT_PENDING_EVENT_CAPACITY = 5_000;

class BoundedEventQueue {
  private readonly records: Array<EventRecord | undefined>;
  private head = 0;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.records = new Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  pushBatch(events: readonly EventRecord[]): number {
    if (events.length >= this.capacity) {
      const dropped = this.size + events.length - this.capacity;
      const retained = events.slice(-this.capacity);
      for (let index = 0; index < retained.length; index += 1) {
        this.records[index] = retained[index];
      }
      this.head = 0;
      this.size = this.capacity;
      return dropped;
    }

    let dropped = 0;
    for (const event of events) {
      if (this.size === this.capacity) {
        this.records[this.head] = event;
        this.head = (this.head + 1) % this.capacity;
        dropped += 1;
      } else {
        this.records[(this.head + this.size) % this.capacity] = event;
        this.size += 1;
      }
    }
    return dropped;
  }

  drain(): EventRecord[] {
    const events: EventRecord[] = [];
    for (let offset = 0; offset < this.size; offset += 1) {
      const index = (this.head + offset) % this.capacity;
      const event = this.records[index];
      if (event) events.push(event);
      this.records[index] = undefined;
    }
    this.head = 0;
    this.size = 0;
    return events;
  }
}

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
  private readonly stdout: EventOutput;
  private readonly appendFile: typeof appendFileToDisk;
  private readonly pendingEventCapacity: number;
  private readonly pendingEvents: BoundedEventQueue;
  private droppedEvents = 0;
  private drainPromise: Promise<void> | null = null;
  private activeDate: string | null = null;
  private activePath: string | null = null;

  constructor(options: LocalEventSinkOptions = {}) {
    this.dir = options.dir;
    this.retentionDays = options.retentionDays;
    this.now = options.now ?? (() => new Date());
    this.stdout = options.stdout ?? process.stdout;
    this.appendFile = options.appendFile ?? appendFileToDisk;
    this.pendingEventCapacity = options.pendingEventCapacity ?? DEFAULT_PENDING_EVENT_CAPACITY;
    if (!Number.isInteger(this.pendingEventCapacity) || this.pendingEventCapacity < 1) {
      throw new Error("pendingEventCapacity must be a positive integer");
    }
    this.pendingEvents = new BoundedEventQueue(this.pendingEventCapacity);
  }

  emit(event: EventRecord): void {
    this.enqueue([event]);
  }

  emitBatch(events: EventRecord[]): void {
    if (events.length === 0) return;
    this.enqueue(events);
  }

  async flush(): Promise<void> {
    while (this.drainPromise) {
      await this.drainPromise;
    }
  }

  /** Resolved path for the active daily file — test hook for reading back lines. */
  currentFilePath(): string | null {
    return this.activePath;
  }

  private enqueue(events: EventRecord[]): void {
    this.droppedEvents += this.pendingEvents.pushBatch(events);
    if (!this.drainPromise) this.startDrain();
  }

  private startDrain(): void {
    const drainPromise = Promise.resolve().then(() => this.drain());
    this.drainPromise = drainPromise;
    void drainPromise.then(
      () => this.finishDrain(drainPromise),
      () => this.finishDrain(drainPromise),
    );
  }

  private finishDrain(completed: Promise<void>): void {
    if (this.drainPromise !== completed) return;
    this.drainPromise = null;
    if (this.pendingEvents.length > 0) this.startDrain();
  }

  private async drain(): Promise<void> {
    while (this.pendingEvents.length > 0) {
      const events = this.pendingEvents.drain();
      const dropped = this.droppedEvents;
      if (dropped > 0) {
        events.unshift({
          timestamp: this.now().toISOString(),
          level: "warn",
          source: "observability",
          name: "sink.dropped",
          payload: { dropped },
        });
      }
      await this.appendEvents(events);
      if (dropped > 0) this.droppedEvents -= dropped;
    }
  }

  private async appendEvents(events: EventRecord[]): Promise<void> {
    const payload = events
      .map((event) => `${JSON.stringify(sanitizeEventRecord(event))}\n`)
      .join("");
    if (!this.stdout.write(payload)) {
      await new Promise<void>((resolve) => this.stdout.once("drain", resolve));
    }
    if (!this.dir) return;
    try {
      const filePath = await this.resolveFilePath();
      if (filePath) await this.appendFile(filePath, payload, { encoding: "utf8", flag: "a" });
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
