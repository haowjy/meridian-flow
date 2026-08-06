/** Bounded in-memory model-request capture; content never enters persistent logs. */
import type {
  ModelRequestDebugRecord,
  ModelRequestDebugRetention,
} from "@meridian/contracts/threads";
import type { ModelRequestDebugStore } from "../../ports/model-request-debug-store.js";

const DEFAULT_CAPACITY = 200;
const DEFAULT_MAX_RECORD_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();

type StoredRecord = { record: ModelRequestDebugRecord; bytes: number };

export interface InMemoryModelRequestDebugStoreOptions {
  capacity?: number;
  maxRecordBytes?: number;
  maxBytes?: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function serializedBytes(value: unknown): number {
  return UTF8_ENCODER.encode(JSON.stringify(value)).byteLength;
}

export class InMemoryModelRequestDebugStore implements ModelRequestDebugStore {
  readonly captureEnabled = true;
  private readonly capacity: number;
  private readonly maxRecordBytes: number;
  private readonly maxBytes: number;
  private readonly records: StoredRecord[] = [];
  private retainedBytes = 0;
  private droppedRecords = 0;
  private droppedBytes = 0;

  constructor(options: InMemoryModelRequestDebugStoreOptions = {}) {
    this.capacity = positiveInteger(options.capacity ?? DEFAULT_CAPACITY, "capacity");
    this.maxRecordBytes = positiveInteger(
      options.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
      "maxRecordBytes",
    );
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
  }

  record(record: ModelRequestDebugRecord): void {
    const retainedRecord: ModelRequestDebugRecord =
      record.request && record.requestBytes > this.maxRecordBytes
        ? {
            ...record,
            capture: {
              status: "omitted",
              reason: "record_too_large",
              maxRecordBytes: this.maxRecordBytes,
            },
            request: null,
          }
        : record;
    const bytes = serializedBytes(retainedRecord);

    if (bytes > this.maxBytes) {
      this.droppedRecords += 1;
      this.droppedBytes += bytes;
      return;
    }

    while (
      this.records.length > 0 &&
      (this.records.length >= this.capacity || this.retainedBytes + bytes > this.maxBytes)
    ) {
      const evicted = this.records.shift();
      if (!evicted) break;
      this.retainedBytes -= evicted.bytes;
      this.droppedRecords += 1;
      this.droppedBytes += evicted.bytes;
    }

    this.records.push({ record: retainedRecord, bytes });
    this.retainedBytes += bytes;
  }

  listByTurn(threadId: string, turnId: string): ModelRequestDebugRecord[] {
    return this.records
      .map(({ record }) => record)
      .filter((record) => record.threadId === threadId && record.turnId === turnId);
  }

  listByThread(threadId: string): ModelRequestDebugRecord[] {
    return this.records
      .map(({ record }) => record)
      .filter((record) => record.threadId === threadId);
  }

  retention(): ModelRequestDebugRetention {
    return {
      retainedRecords: this.records.length,
      retainedBytes: this.retainedBytes,
      droppedRecords: this.droppedRecords,
      droppedBytes: this.droppedBytes,
    };
  }
}

export function createInMemoryModelRequestDebugStore(
  options?: InMemoryModelRequestDebugStoreOptions,
): InMemoryModelRequestDebugStore {
  return new InMemoryModelRequestDebugStore(options);
}
