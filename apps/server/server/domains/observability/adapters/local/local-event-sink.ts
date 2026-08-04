/**
 * Local EventSink: always writes structured JSON events to stdout for platform
 * log capture and optionally mirrors them to `LOG_DIR/YYYY-MM-DD.jsonl` when a
 * log directory is configured. Daily files can be retained for a bounded number
 * of days. Writes are serialized per process.
 */
import { appendFile as appendFileToDisk, mkdir, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { EventRecord, EventSink } from "../../ports/event-sink.js";
import { serializedEventBytes } from "../../safe-event.js";

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
  /** Maximum serialized bytes waiting behind the active write. */
  pendingByteCapacity?: number;
  /** Maximum bytes in one JSONL segment. */
  segmentBytes?: number;
  /** Maximum total bytes retained across JSONL segments. */
  maxBytes?: number;
};

const LOG_FILE_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{4}\.jsonl$/;
const DEFAULT_PENDING_EVENT_CAPACITY = 5_000;
const DEFAULT_PENDING_BYTE_CAPACITY = 16 * 1_024 * 1_024;
const DEFAULT_SEGMENT_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_MAX_BYTES = 128 * 1_024 * 1_024;

type QueuedEvent = { event: EventRecord; bytes: number };
type DropCount = { records: number; bytes: number };

class BoundedEventQueue {
  private readonly records: Array<QueuedEvent | undefined>;
  private head = 0;
  private size = 0;
  private retainedBytes = 0;

  constructor(
    private readonly capacity: number,
    private readonly byteCapacity: number,
  ) {
    this.records = new Array(capacity);
  }

  get length(): number {
    return this.size;
  }

  pushBatch(events: readonly EventRecord[]): DropCount {
    const dropped = { records: 0, bytes: 0 };
    for (const event of events) {
      const bytes = serializedEventBytes(event);
      while (
        this.size > 0 &&
        (this.size === this.capacity || this.retainedBytes + bytes > this.byteCapacity)
      ) {
        const evicted = this.shift();
        if (!evicted) break;
        dropped.records += 1;
        dropped.bytes += evicted.bytes;
      }
      const index = (this.head + this.size) % this.capacity;
      this.records[index] = { event, bytes };
      this.size += 1;
      this.retainedBytes += bytes;
    }
    return dropped;
  }

  drain(): EventRecord[] {
    const events: EventRecord[] = [];
    for (let offset = 0; offset < this.size; offset += 1) {
      const index = (this.head + offset) % this.capacity;
      const queued = this.records[index];
      if (queued) events.push(queued.event);
      this.records[index] = undefined;
    }
    this.head = 0;
    this.size = 0;
    this.retainedBytes = 0;
    return events;
  }

  private shift(): QueuedEvent | undefined {
    if (this.size === 0) return undefined;
    const queued = this.records[this.head];
    this.records[this.head] = undefined;
    this.head = (this.head + 1) % this.capacity;
    this.size -= 1;
    if (queued) this.retainedBytes -= queued.bytes;
    return queued;
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
  private readonly pendingByteCapacity: number;
  private readonly segmentBytes: number;
  private readonly maxBytes: number;
  private readonly pendingEvents: BoundedEventQueue;
  private droppedEvents = 0;
  private droppedBytes = 0;
  private drainPromise: Promise<void> | null = null;
  private activeDate: string | null = null;
  private activePath: string | null = null;
  private activeBytes = 0;
  private activeSegment = -1;

  constructor(options: LocalEventSinkOptions = {}) {
    this.dir = options.dir;
    this.retentionDays = options.retentionDays;
    this.now = options.now ?? (() => new Date());
    this.stdout = options.stdout ?? process.stdout;
    this.appendFile = options.appendFile ?? appendFileToDisk;
    this.pendingEventCapacity = options.pendingEventCapacity ?? DEFAULT_PENDING_EVENT_CAPACITY;
    this.pendingByteCapacity = options.pendingByteCapacity ?? DEFAULT_PENDING_BYTE_CAPACITY;
    this.segmentBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    if (!Number.isInteger(this.pendingEventCapacity) || this.pendingEventCapacity < 1) {
      throw new Error("pendingEventCapacity must be a positive integer");
    }
    if (!Number.isInteger(this.pendingByteCapacity) || this.pendingByteCapacity < 1) {
      throw new Error("pendingByteCapacity must be a positive integer");
    }
    if (!Number.isInteger(this.segmentBytes) || this.segmentBytes < 1) {
      throw new Error("segmentBytes must be a positive integer");
    }
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < this.segmentBytes) {
      throw new Error("maxBytes must be an integer greater than or equal to segmentBytes");
    }
    this.pendingEvents = new BoundedEventQueue(this.pendingEventCapacity, this.pendingByteCapacity);
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
    const dropped = this.pendingEvents.pushBatch(events);
    this.droppedEvents += dropped.records;
    this.droppedBytes += dropped.bytes;
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
          eventId: crypto.randomUUID(),
          timestamp: this.now().toISOString(),
          level: "warn",
          source: "observability",
          name: "sink.dropped",
          sensitivity: "safe",
          payload: { droppedRecords: dropped, droppedBytes: this.droppedBytes },
        });
      }
      await this.appendEvents(events);
      if (dropped > 0) {
        this.droppedEvents -= dropped;
        this.droppedBytes = 0;
      }
    }
  }

  private async appendEvents(events: EventRecord[]): Promise<void> {
    const lines = events.map((event) => `${JSON.stringify(event)}\n`);
    const payload = lines.join("");
    if (!this.stdout.write(payload)) {
      await new Promise<void>((resolve) => this.stdout.once("drain", resolve));
    }
    if (!this.dir) return;
    try {
      let cursor = 0;
      while (cursor < lines.length) {
        const firstLineBytes = Buffer.byteLength(lines[cursor] as string, "utf8");
        const filePath = await this.resolveFilePath(firstLineBytes);
        if (!filePath) break;
        const remainingBytes = this.segmentBytes - this.activeBytes;
        const chunk: string[] = [];
        let chunkBytes = 0;
        while (cursor < lines.length) {
          const line = lines[cursor] as string;
          const lineBytes = Buffer.byteLength(line, "utf8");
          if (chunk.length > 0 && chunkBytes + lineBytes > remainingBytes) break;
          chunk.push(line);
          chunkBytes += lineBytes;
          cursor += 1;
        }
        await this.appendFile(filePath, chunk.join(""), { encoding: "utf8", flag: "a" });
        this.activeBytes += chunkBytes;
      }
    } catch {
      // Stdout is the required local sink; JSONL mirroring is best-effort.
    }
  }

  private async resolveFilePath(nextBytes: number): Promise<string | null> {
    if (!this.dir) return null;
    const now = this.now();
    const date = utcDateStamp(now);
    if (
      this.activeDate === date &&
      this.activePath &&
      this.activeBytes + nextBytes <= this.segmentBytes
    ) {
      return this.activePath;
    }

    await mkdir(this.dir, { recursive: true });
    await this.pruneFiles(now, nextBytes);
    if (this.activeDate !== date) {
      const existing = (await readdir(this.dir))
        .filter((name) => name.startsWith(`${date}-`) && LOG_FILE_PATTERN.test(name))
        .sort();
      const latest = existing.at(-1);
      if (latest) {
        const latestPath = path.join(this.dir, latest);
        const latestBytes = (await stat(latestPath)).size;
        const latestSegment = Number(latest.slice(11, 15));
        if (latestBytes + nextBytes <= this.segmentBytes) {
          this.activeDate = date;
          this.activePath = latestPath;
          this.activeBytes = latestBytes;
          this.activeSegment = latestSegment;
          return latestPath;
        }
        this.activeSegment = latestSegment;
      } else {
        this.activeSegment = -1;
      }
    }
    this.activeSegment += 1;
    const filePath = path.join(
      this.dir,
      `${date}-${String(this.activeSegment).padStart(4, "0")}.jsonl`,
    );
    this.activeDate = date;
    this.activePath = filePath;
    this.activeBytes = 0;
    return filePath;
  }

  private async pruneFiles(now: Date, reserveBytes: number): Promise<void> {
    if (!this.dir) return;
    const cutoff =
      this.retentionDays === undefined ? undefined : cutoffDateStamp(now, this.retentionDays);
    const entries = await readdir(this.dir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && LOG_FILE_PATTERN.test(entry.name))
      .map((entry) => path.join(this.dir as string, entry.name))
      .sort();
    const retained: Array<{ filePath: string; bytes: number }> = [];
    for (const filePath of files) {
      if (cutoff !== undefined && path.basename(filePath).slice(0, 10) < cutoff) {
        await unlink(filePath);
      } else {
        retained.push({ filePath, bytes: (await stat(filePath)).size });
      }
    }
    let totalBytes = retained.reduce((total, file) => total + file.bytes, 0);
    for (const file of retained) {
      if (totalBytes + reserveBytes <= this.maxBytes) break;
      if (file.filePath === this.activePath) continue;
      await unlink(file.filePath);
      totalBytes -= file.bytes;
    }
  }
}

export function createLocalEventSink(options: LocalEventSinkOptions = {}): EventSink {
  return new LocalEventSink(options);
}
