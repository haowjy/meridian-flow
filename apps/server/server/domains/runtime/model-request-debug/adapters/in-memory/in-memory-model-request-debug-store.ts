/**
 * In-memory ring buffer for ModelRequestDebugRecord — bounded FIFO eviction
 * across the whole process (not per thread).
 */
import type { ModelRequestDebugRecord } from "@meridian/contracts/threads";

import type { ModelRequestDebugStore } from "../../ports/model-request-debug-store.js";

const DEFAULT_CAPACITY = 200;

export interface InMemoryModelRequestDebugStoreOptions {
  capacity?: number;
}

export class InMemoryModelRequestDebugStore implements ModelRequestDebugStore {
  readonly captureEnabled = true;
  private readonly capacity: number;
  private readonly records: ModelRequestDebugRecord[] = [];

  constructor(options: InMemoryModelRequestDebugStoreOptions = {}) {
    this.capacity = options.capacity ?? DEFAULT_CAPACITY;
  }

  record(record: ModelRequestDebugRecord): void {
    this.records.push(record);
    while (this.records.length > this.capacity) {
      this.records.shift();
    }
  }

  listByTurn(threadId: string, turnId: string): ModelRequestDebugRecord[] {
    return this.records.filter(
      (record) => record.threadId === threadId && record.turnId === turnId,
    );
  }

  listByThread(threadId: string): ModelRequestDebugRecord[] {
    return this.records.filter((record) => record.threadId === threadId);
  }
}

export function createInMemoryModelRequestDebugStore(
  options?: InMemoryModelRequestDebugStoreOptions,
): InMemoryModelRequestDebugStore {
  return new InMemoryModelRequestDebugStore(options);
}
