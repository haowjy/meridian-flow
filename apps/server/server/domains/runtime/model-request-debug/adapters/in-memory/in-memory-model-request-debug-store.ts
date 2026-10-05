/** Bounded in-memory model-request capture; content never enters persistent logs. */
import type {
  ModelRequestDebugRecord,
  ModelRequestDebugRetention,
  ProviderErrorResponse,
} from "@meridian/contracts/threads";
import {
  buildModelRequestDebugRecord,
  type ModelRequestDebugCaptureInput,
} from "../../build-record.js";
import type { ModelRequestDebugStore } from "../../ports/model-request-debug-store.js";

const DEFAULT_CAPACITY = 200;
const DEFAULT_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

type StoredRecord = { record: ModelRequestDebugRecord; bytes: number };

export interface InMemoryModelRequestDebugStoreOptions {
  capacity?: number;
  maxRequestBytes?: number;
  maxBytes?: number;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export class InMemoryModelRequestDebugStore implements ModelRequestDebugStore {
  readonly captureEnabled = true;
  private readonly capacity: number;
  private readonly maxRequestBytes: number;
  private readonly maxBytes: number;
  private readonly records: StoredRecord[] = [];
  private retainedBytes = 0;
  private droppedRecords = 0;
  private droppedBytes = 0;

  constructor(options: InMemoryModelRequestDebugStoreOptions = {}) {
    this.capacity = positiveInteger(options.capacity ?? DEFAULT_CAPACITY, "capacity");
    this.maxRequestBytes = positiveInteger(
      options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES,
      "maxRequestBytes",
    );
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes");
  }

  capture(input: ModelRequestDebugCaptureInput): void {
    const record = buildModelRequestDebugRecord(input, this.maxRequestBytes);
    const bytes = serializedBytes(record);

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

    this.records.push({ record, bytes });
    this.retainedBytes += bytes;
  }

  recordProviderError(gatewayCallId: string, error: ProviderErrorResponse): void {
    let index = this.records.length - 1;
    while (index >= 0 && this.records[index]?.record.gatewayCallId !== gatewayCallId) index -= 1;
    const stored = this.records[index];
    if (!stored) return;
    const record = { ...stored.record, providerError: error };
    const bytes = serializedBytes(record);
    this.records[index] = { record, bytes };
    // The body is capped upstream, so one error cannot push retention far past
    // the bound; the next capture evicts back under it.
    this.retainedBytes += bytes - stored.bytes;
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
